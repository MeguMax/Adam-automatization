import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { FilingJobView } from './database';
import { filingReleaseChecks } from './mifilePreparationEvidence';
import { checkoutReviewIssues, receiptEventKey, receiptSummary, validateReceipt,
    type CheckoutAccount, type CheckoutInspection, type CheckoutInspectionResult, type CheckoutQuote,
    type MiFileReceiptObservation } from './mifileCheckout';

export class CheckoutStore {
    constructor(private db: DatabaseSync, private getFilingJob: (id: string) => FilingJobView | null,
        private audit: (id: string, action: string, details: Record<string, unknown>) => void) {}

    private transaction<T>(action: () => T): T {
        this.db.exec('BEGIN IMMEDIATE');
        try { const result = action(); this.db.exec('COMMIT'); return result; }
        catch (error) { this.db.exec('ROLLBACK'); throw error; }
    }

    get(id: string): CheckoutInspection | null {
        const row = this.db.prepare('SELECT * FROM mifile_checkout_inspections WHERE id = ?').get(id) as Record<string, unknown> | undefined;
        let result: CheckoutInspectionResult | null = null;
        if (row?.result_json) { try { result = JSON.parse(String(row.result_json)); } catch { /* Corrupt evidence is never actionable. */ } }
        return row ? { id: String(row.id), filingJobId: String(row.filing_job_id), kind: row.kind as CheckoutInspection['kind'],
            status: row.status as CheckoutInspection['status'], stage: String(row.stage), accountIdentity: String(row.account_identity),
            createdAt: String(row.created_at), startedAt: row.started_at as string | null, finishedAt: row.finished_at as string | null,
            error: row.result_json && !result ? 'The stored inspection cannot be read. Refresh the check.' : row.error_message as string | null, result } : null;
    }

    queue(filingJobId: string, kind: CheckoutInspection['kind'], account: CheckoutAccount): CheckoutInspection {
        if (!['quote', 'receipts'].includes(kind)) throw new Error('Choose a valid read-only MiFILE inspection.');
        return this.transaction(() => {
            const job = this.getFilingJob(filingJobId);
            if (!job || !filingReleaseChecks(job, account).sameAccount) throw new Error('A verified Prepared bundle in the current account is required.');
            const active = this.db.prepare("SELECT id FROM mifile_checkout_inspections WHERE filing_job_id = ? AND status IN ('queued','running')")
                .get(filingJobId) as { id: string } | undefined;
            if (active) return this.get(active.id)!;
            const id = randomUUID();
            this.db.prepare(`INSERT INTO mifile_checkout_inspections
                (id, filing_job_id, kind, status, account_identity, created_at) VALUES (?, ?, ?, 'queued', ?, ?)`)
                .run(id, filingJobId, kind, account.identity, new Date().toISOString());
            this.audit(id, 'checkout_inspection_queued', { filingJobId, kind });
            return this.get(id)!;
        });
    }

    claim(): CheckoutInspection | null {
        return this.transaction(() => {
            if (this.db.prepare("SELECT 1 FROM filing_jobs WHERE status = 'running' LIMIT 1").get() ||
                this.db.prepare("SELECT 1 FROM mifile_checkout_inspections WHERE status = 'running' LIMIT 1").get()) return null;
            const row = this.db.prepare("SELECT id FROM mifile_checkout_inspections WHERE status = 'queued' ORDER BY created_at, rowid LIMIT 1")
                .get() as { id: string } | undefined;
            if (!row) return null;
            this.db.prepare("UPDATE mifile_checkout_inspections SET status = 'running', started_at = ? WHERE id = ? AND status = 'queued'")
                .run(new Date().toISOString(), row.id);
            return this.get(row.id);
        });
    }

    recover(): number {
        return Number(this.db.prepare(`UPDATE mifile_checkout_inspections SET status = 'failed', finished_at = ?,
            stage = 'failed', error_message = 'The read-only check was interrupted. Refresh it; no payment or court submission was attempted.'
            WHERE status = 'running'`).run(new Date().toISOString()).changes);
    }

    progress(id: string, stage: string): void {
        this.db.prepare("UPDATE mifile_checkout_inspections SET stage = ? WHERE id = ? AND status = 'running'")
            .run(stage.slice(0, 80), id);
    }

    complete(id: string, result: CheckoutInspectionResult, account: CheckoutAccount): void {
        this.transaction(() => {
            const inspection = this.get(id), job = inspection && this.getFilingJob(inspection.filingJobId);
            if (!inspection || inspection.status !== 'running' || !job || inspection.kind !== result.kind ||
                inspection.accountIdentity !== account.identity || !filingReleaseChecks(job, account).sameAccount) {
                throw new Error('The inspection account or prepared bundle changed.');
            }
            if (result.kind === 'quote') {
                const issues = checkoutReviewIssues(result.quote, job, account);
                // An exact displayed quote is retained even when payment setup is incomplete.
                if (issues.some(issue => !/^(Add a payment method|Select the intended payment method)/.test(issue))) {
                    throw new Error(issues.join(' '));
                }
            } else {
                if (result.observations.length > 200 || !['unsubmitted', 'found', 'inconclusive'].includes(result.state)) {
                    throw new Error('Unrecognized receipt result.');
                }
                for (const observation of result.observations) {
                    validateReceipt(observation, job, account);
                    const key = receiptEventKey(observation);
                    const prior = this.db.prepare(`SELECT event_key FROM mifile_receipt_events WHERE filing_job_id = ?
                        AND external_reference = ? AND receipt_kind = ? AND remote_status = ? AND document_id = ?`)
                        .get(job.id, observation.externalReference, observation.kind, observation.status, observation.documentId || '') as { event_key: string } | undefined;
                    if (prior && prior.event_key !== key) throw new Error('Conflicting values were reported for an existing receipt. Review MiFILE; no payment retry is allowed.');
                    this.db.prepare(`INSERT INTO mifile_receipt_events
                        (event_key, filing_job_id, account_identity, observed_at, event_json, external_reference, receipt_kind, remote_status, document_id)
                        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                        ON CONFLICT(event_key) DO UPDATE SET observed_at = excluded.observed_at`)
                        .run(key, job.id, account.identity, observation.observedAt, JSON.stringify(observation),
                            observation.externalReference, observation.kind, observation.status, observation.documentId || '');
                }
            }
            this.db.prepare("UPDATE mifile_checkout_inspections SET status = 'completed', stage = 'completed', finished_at = ?, result_json = ?, error_message = NULL WHERE id = ?")
                .run(new Date().toISOString(), JSON.stringify(result), id);
            this.audit(id, 'checkout_inspection_completed', { filingJobId: job.id, kind: result.kind,
                paymentAttempted: false, courtSubmissionAttempted: false });
        });
    }

    fail(id: string, error: string): void {
        const inspection = this.get(id);
        if (!inspection || inspection.status !== 'running') return;
        this.db.prepare("UPDATE mifile_checkout_inspections SET status = 'failed', stage = 'failed', finished_at = ?, error_message = ? WHERE id = ?")
            .run(new Date().toISOString(), error.slice(0, 1200), id);
        this.audit(id, 'checkout_inspection_failed', { filingJobId: inspection.filingJobId, kind: inspection.kind });
    }

    state(filingJobId: string, account: CheckoutAccount, now = Date.now()) {
        const job = this.getFilingJob(filingJobId);
        const rows = this.db.prepare('SELECT id FROM mifile_checkout_inspections WHERE filing_job_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 25')
            .all(filingJobId) as Array<{ id: string }>;
        const inspections = rows.map(row => this.get(row.id)!);
        const active = inspections.find(item => ['queued', 'running'].includes(item.status));
        const latestQuote = inspections.find(item => item.kind === 'quote');
        const quoteInspection = inspections.find(item => item.kind === 'quote' && item.status === 'completed' && item.result?.kind === 'quote');
        const quote = quoteInspection?.result?.kind === 'quote' ? quoteInspection.result.quote : null;
        const issues = quote && job ? checkoutReviewIssues(quote, job, account, now) : [];
        if (quote && latestQuote?.id !== quoteInspection?.id) issues.push('The latest checkout check has not succeeded. Refresh checkout before confirming.');
        if (active) issues.push('Wait for the current MiFILE inspection to finish.');
        const confirmation = quote ? this.db.prepare('SELECT confirmed_at, confirmed_by, quote_digest FROM mifile_checkout_confirmations WHERE quote_id = ?')
            .get(quote.id) as { confirmed_at: string; confirmed_by: string; quote_digest: string } | undefined : undefined;
        const receipts = (this.db.prepare('SELECT event_json, observed_at FROM mifile_receipt_events WHERE filing_job_id = ? AND account_identity = ? ORDER BY observed_at DESC, rowid DESC LIMIT 200')
            .all(filingJobId, account.identity) as Array<{ event_json: string; observed_at: string }>).map(row =>
                ({ ...JSON.parse(row.event_json), observedAt: row.observed_at }) as MiFileReceiptObservation);
        const publicQuote = quote && !issues.includes('The stored checkout snapshot is invalid.')
            ? (({ accountIdentity: privateIdentity, paymentMethodFingerprint: privateMethod, ...rest }) => rest)(quote) : null;
        const last = inspections[0];
        const receiptCheck = inspections.find(item => item.kind === 'receipts');
        const receiptResult = receiptCheck?.result?.kind === 'receipts' ? receiptCheck.result : null;
        return {
            inspection: last ? { id: last.id, kind: last.kind, status: last.status, stage: last.stage, createdAt: last.createdAt,
                startedAt: last.startedAt, finishedAt: last.finishedAt, error: last.error } : null,
            active: Boolean(active), quote: publicQuote, issues,
            canConfirm: Boolean(quote && !issues.length),
            confirmedAt: !issues.length && confirmation && confirmation.quote_digest === quote?.quoteDigest ? confirmation.confirmed_at : null,
            checkoutVerified: Boolean(quote && job && latestQuote?.id === quoteInspection?.id &&
                issues.every(issue => /^(Add a payment method|Select the intended payment method)/.test(issue))),
            receipts, receiptSummary: receiptSummary(receipts), receiptCheckState: receiptResult?.state || null,
            receiptCheckIssue: quote && receipts.some(receipt => receipt.kind === 'payment' && receipt.status === 'Paid' && receipt.totalCents !== quote.totalCents)
                ? 'The payment receipt amount differs from the reviewed checkout quote. Check MiFILE; do not retry payment.' : receiptResult?.issue || null,
            confirmationPurpose: 'review_only', paymentExecutionEnabled: false, courtSubmissionEnabled: false,
        };
    }

    confirm(filingJobId: string, input: { quoteId: string; quoteDigest: string; totalCents: number }, account: CheckoutAccount,
        confirmedBy: string, now = Date.now()): void {
        this.transaction(() => {
            const state = this.state(filingJobId, account, now), quote = state.quote;
            if (!state.canConfirm || !quote || quote.id !== input.quoteId || quote.quoteDigest !== input.quoteDigest ||
                !Number.isSafeInteger(input.totalCents) || input.totalCents !== quote.totalCents) {
                throw new Error(state.issues.join(' ') || 'The exact checkout amount changed. Refresh it before confirming.');
            }
            const change = this.db.prepare(`INSERT INTO mifile_checkout_confirmations
                (quote_id, filing_job_id, quote_digest, total_cents, account_identity, confirmed_at, confirmed_by)
                VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(quote_id) DO NOTHING`)
                .run(quote.id, filingJobId, quote.quoteDigest, quote.totalCents, account.identity, new Date(now).toISOString(), confirmedBy);
            if (Number(change.changes)) this.audit(quote.id, 'checkout_amount_reviewed', { filingJobId, totalCents: quote.totalCents,
                purpose: 'review_only', paymentAuthorized: false, courtSubmissionAuthorized: false });
        });
    }
}
