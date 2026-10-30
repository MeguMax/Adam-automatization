import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { FilingJobView } from './database';
import { filingReleaseChecks } from './mifilePreparationEvidence';
import { mifileOutcome } from './mifileOutcome';
import { checkoutReviewIssues, digest, receiptEventKey, receiptSummary, validateReceipt,
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

    private methodChoiceRecord(filingJobId: string, account: CheckoutAccount) {
        return this.db.prepare(`SELECT method_fingerprint, chosen_at FROM mifile_payment_method_choices
            WHERE filing_job_id = ? AND account_identity = ?`).get(filingJobId, account.identity) as
            {method_fingerprint:string|null;chosen_at:string} | undefined;
    }

    paymentMethodChoice(filingJobId: string, account: CheckoutAccount): string | null {
        return this.methodChoiceRecord(filingJobId,account)?.method_fingerprint || null;
    }

    choosePaymentMethod(filingJobId: string, input: {quoteId:string;quoteDigest:string;fingerprint:string},
        account: CheckoutAccount, chosenBy: string, now = Date.now()): void {
        this.transaction(() => {
            const state = this.state(filingJobId, account, now), quote = state.quote;
            if (!state.checkoutVerified || state.active || state.receiptSummary.submissionObserved || !quote ||
                quote.id !== input.quoteId || quote.quoteDigest !== input.quoteDigest ||
                !/^[a-f0-9]{64}$/.test(input.fingerprint) ||
                quote.availablePaymentMethods?.filter(method => method.fingerprint === input.fingerprint).length !== 1) {
                throw new Error('Refresh checkout and choose one of the verified available payment accounts. No payment was authorized.');
            }
            const current = this.paymentMethodChoice(filingJobId, account);
            if (current === input.fingerprint) return;
            this.db.prepare(`INSERT INTO mifile_payment_method_choices
                (filing_job_id, account_identity, method_fingerprint, chosen_at, chosen_by) VALUES (?, ?, ?, ?, ?)
                ON CONFLICT(filing_job_id) DO UPDATE SET account_identity = excluded.account_identity,
                method_fingerprint = excluded.method_fingerprint, chosen_at = excluded.chosen_at, chosen_by = excluded.chosen_by`)
                .run(filingJobId,account.identity,input.fingerprint,new Date(now).toISOString(),chosenBy);
            this.audit(quote.id,'checkout_payment_account_chosen',{filingJobId,purpose:'quote_only',
                paymentAuthorized:false,courtSubmissionAuthorized:false});
        });
    }

    clearPaymentMethod(filingJobId: string, account: CheckoutAccount, chosenBy = 'admin', now = Date.now()): void {
        this.transaction(() => {
            const job = this.getFilingJob(filingJobId), state = this.state(filingJobId,account);
            if (!job || !filingReleaseChecks(job,account).sameAccount || state.active || state.receiptSummary.submissionObserved) {
                throw new Error('The verified bundle must be idle and Unsubmitted before changing its payment account choice.');
            }
            if (!this.paymentMethodChoice(filingJobId,account)) return;
            // Retain the change time so clearing a choice cannot revive an older reviewed quote.
            this.db.prepare(`UPDATE mifile_payment_method_choices SET method_fingerprint = NULL, chosen_at = ?, chosen_by = ?
                WHERE filing_job_id = ? AND account_identity = ?`)
                .run(new Date(now).toISOString(),chosenBy,filingJobId,account.identity);
            this.audit(filingJobId,'checkout_payment_account_cleared',{purpose:'quote_only'});
        });
    }

    get(id: string): CheckoutInspection | null {
        const row = this.db.prepare('SELECT * FROM mifile_checkout_inspections WHERE id = ?').get(id) as Record<string, unknown> | undefined;
        let result: CheckoutInspectionResult | null = null;
        if (row?.result_json) { try { result = JSON.parse(String(row.result_json)); } catch { /* Corrupt evidence is never actionable. */ } }
        return row ? { id: String(row.id), filingJobId: String(row.filing_job_id), kind: row.kind as CheckoutInspection['kind'],
            triggerSource:row.trigger_source === 'automatic' ? 'automatic' : 'manual',
            status: row.status as CheckoutInspection['status'], stage: String(row.stage), accountIdentity: String(row.account_identity),
            createdAt: String(row.created_at), startedAt: row.started_at as string | null, finishedAt: row.finished_at as string | null,
            error: row.result_json && !result ? 'The stored inspection cannot be read. Refresh the check.' : row.error_message as string | null, result } : null;
    }

    queue(filingJobId: string, kind: CheckoutInspection['kind'], account: CheckoutAccount): CheckoutInspection {
        if (!['quote', 'receipts'].includes(kind)) throw new Error('Choose a valid read-only MiFILE inspection.');
        return this.transaction(() => {
            const job = this.getFilingJob(filingJobId);
            if (!job || !filingReleaseChecks(job, account).sameAccount) throw new Error('A verified Prepared bundle in the current account is required.');
            const state = this.state(filingJobId,account);
            if (kind === 'quote' && (state.receiptSummary.submissionObserved || state.issues.some(issue => issue.startsWith('Stored receipt evidence')))) {
                throw new Error('Reconcile the reported submission or payment in MiFILE before another checkout check. Do not retry payment.');
            }
            const active = this.db.prepare("SELECT id FROM mifile_checkout_inspections WHERE filing_job_id = ? AND status IN ('queued','running')")
                .get(filingJobId) as { id: string } | undefined;
            if (active) return this.get(active.id)!;
            return this.insertInspection(filingJobId,kind,account,'manual');
        });
    }

    private insertInspection(filingJobId: string, kind: CheckoutInspection['kind'], account: CheckoutAccount,
        source: CheckoutInspection['triggerSource'], now = Date.now()): CheckoutInspection {
        const id = randomUUID();
        this.db.prepare(`INSERT INTO mifile_checkout_inspections
            (id, filing_job_id, kind, status, account_identity, created_at, trigger_source) VALUES (?, ?, ?, 'queued', ?, ?, ?)`)
            .run(id,filingJobId,kind,account.identity,new Date(now).toISOString(),source);
        this.audit(id,'checkout_inspection_queued',{filingJobId,kind,source});
        return this.get(id)!;
    }

    private pruneAutomaticHistory(filingJobId: string): void {
        this.db.prepare(`DELETE FROM mifile_checkout_inspections WHERE filing_job_id = ? AND kind = 'receipts'
            AND trigger_source = 'automatic' AND status IN ('completed','failed') AND id NOT IN (
                SELECT id FROM mifile_checkout_inspections WHERE filing_job_id = ? AND kind = 'receipts'
                AND trigger_source = 'automatic' AND status IN ('completed','failed')
                ORDER BY created_at DESC, rowid DESC LIMIT 10)`)
            .run(filingJobId,filingJobId);
    }

    refreshReceiptsIfDue(filingJobId: string, account: CheckoutAccount, now = Date.now()): CheckoutInspection | null {
        return this.transaction(() => {
            const job = this.getFilingJob(filingJobId), checks = job && filingReleaseChecks(job,account);
            if (!checks?.sameAccount || !checks.primaryAccountConfirmed || checks.testOnly) return null;
            if (this.db.prepare(`SELECT 1 FROM mifile_checkout_inspections WHERE filing_job_id = ? AND status IN ('queued','running')`)
                .get(filingJobId)) return null;
            const rows = this.db.prepare(`SELECT id FROM mifile_checkout_inspections WHERE filing_job_id = ?
                AND account_identity = ? AND kind = 'receipts' ORDER BY created_at DESC, rowid DESC LIMIT 5`)
                .all(filingJobId,account.identity) as Array<{id:string}>;
            const recent = rows.map(row => this.get(row.id)!);
            const failures = recent.findIndex(item => item.status === 'completed' && item.result?.kind === 'receipts' && item.result.state !== 'inconclusive');
            const consecutiveFailures = failures < 0 ? recent.length : failures;
            const delayMs = Math.min(60,5 * 2 ** consecutiveFailures) * 60_000;
            const latestAt = recent[0] ? Date.parse(recent[0].finishedAt || recent[0].createdAt) : null;
            if (latestAt !== null && (!Number.isFinite(latestAt) || now - latestAt < delayMs)) return null;
            const backlog = this.db.prepare(`SELECT count(*) AS n FROM mifile_checkout_inspections
                WHERE trigger_source = 'automatic' AND status IN ('queued','running')`).get() as {n:number};
            if (backlog.n >= 5) return null;
            return this.insertInspection(filingJobId,'receipts',account,'automatic',now);
        });
    }

    claim(): CheckoutInspection | null {
        return this.transaction(() => {
            if (this.db.prepare("SELECT 1 FROM filing_jobs WHERE status = 'running' LIMIT 1").get() ||
                this.db.prepare("SELECT 1 FROM mifile_checkout_inspections WHERE status = 'running' LIMIT 1").get()) return null;
            const row = this.db.prepare(`SELECT id FROM mifile_checkout_inspections WHERE status = 'queued'
                AND (trigger_source = 'manual' OR NOT EXISTS(SELECT 1 FROM filing_jobs WHERE status = 'queued'))
                ORDER BY CASE trigger_source WHEN 'manual' THEN 0 ELSE 1 END, created_at, rowid LIMIT 1`)
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
                const choice = this.paymentMethodChoice(job.id,account);
                if (choice && result.quote.totalCents > 0 && result.quote.paymentMethodFingerprint !== choice) {
                    throw new Error('MiFILE did not retain the chosen payment account. Clear the choice and refresh checkout.');
                }
                // An exact displayed quote is retained even when payment setup is incomplete.
                if (issues.some(issue => !/^(Add a payment method|Select the intended payment method|Verify the payment account)/.test(issue))) {
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
                if (!Number.isFinite(Date.parse(result.checkedAt)) || result.state === 'unsubmitted' &&
                    (!result.observations.some(item => item.kind === 'bundle_status' && item.status === 'Unsubmitted') ||
                        receiptSummary(result.observations).submissionObserved)) {
                    throw new Error('Unsubmitted status could not be verified from the receipt observations.');
                }
            }
            this.db.prepare("UPDATE mifile_checkout_inspections SET status = 'completed', stage = 'completed', finished_at = ?, result_json = ?, error_message = NULL WHERE id = ?")
                .run(new Date().toISOString(), JSON.stringify(result), id);
            this.audit(id, 'checkout_inspection_completed', { filingJobId: job.id, kind: result.kind,
                paymentAttempted: false, courtSubmissionAttempted: false });
            this.recordPreflight(job.id,account);
            this.pruneAutomaticHistory(job.id);
        });
    }

    fail(id: string, error: string): void {
        const inspection = this.get(id);
        if (!inspection || inspection.status !== 'running') return;
        this.db.prepare("UPDATE mifile_checkout_inspections SET status = 'failed', stage = 'failed', finished_at = ?, error_message = ? WHERE id = ?")
            .run(new Date().toISOString(), error.slice(0, 1200), id);
        this.audit(id, 'checkout_inspection_failed', { filingJobId: inspection.filingJobId, kind: inspection.kind });
        this.pruneAutomaticHistory(inspection.filingJobId);
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
        const receipts: MiFileReceiptObservation[] = [];
        let receiptEvidenceInvalid = false;
        const receiptRows = this.db.prepare('SELECT event_json, observed_at FROM mifile_receipt_events WHERE filing_job_id = ? ORDER BY observed_at DESC, rowid DESC LIMIT 201')
            .all(filingJobId) as Array<{event_json:string;observed_at:string}>;
        if (receiptRows.length > 200) receiptEvidenceInvalid = true;
        for (const row of receiptRows.slice(0,200)) {
            try {
                const observation = {...JSON.parse(row.event_json),observedAt:row.observed_at} as MiFileReceiptObservation;
                // Password rotation must not hide a payment already observed in the same MiFILE account.
                if (observation.accountEmail && observation.accountEmail !== account.username.trim().toLowerCase()) continue;
                if (!job) throw new Error('Missing prepared bundle');
                validateReceipt(observation,job,account);
                receipts.push(observation);
            } catch { receiptEvidenceInvalid = true; }
        }
        if (receiptEvidenceInvalid) issues.push('Stored receipt evidence needs reconciliation. Check MiFILE; do not retry payment.');
        const summary = receiptSummary(receipts);
        const choiceRecord = this.methodChoiceRecord(filingJobId,account);
        const choice = choiceRecord?.method_fingerprint || null;
        if (quote && choiceRecord && (!Number.isFinite(Date.parse(choiceRecord.chosen_at)) ||
            Date.parse(quote.quotedAt) <= Date.parse(choiceRecord.chosen_at) ||
            choice && quote.totalCents > 0 && quote.paymentMethodFingerprint !== choice)) {
            issues.push('The chosen payment account needs a fresh checkout check.');
        }
        if (summary.submissionObserved) issues.push('MiFILE has already reported submission or payment activity. Reconcile receipts; do not retry payment.');
        const publicQuote = quote && !issues.includes('The stored checkout snapshot is invalid.')
            ? (({ accountIdentity: privateIdentity, paymentMethodFingerprint: privateMethod, ...rest }) => rest)(quote) : null;
        const last = inspections[0];
        const receiptCheck = inspections.find(item => item.kind === 'receipts' && item.accountIdentity === account.identity);
        const receiptResult = receiptCheck?.status === 'completed' && receiptCheck.result?.kind === 'receipts' ? receiptCheck.result : null;
        const recentUnsubmitted = receiptResult?.state === 'unsubmitted' &&
            Number.isFinite(Date.parse(receiptResult.checkedAt)) && Date.parse(receiptResult.checkedAt) <= now &&
            now - Date.parse(receiptResult.checkedAt) < 15 * 60_000;
        const reviewedAt = !issues.length && confirmation && confirmation.quote_digest === quote?.quoteDigest ? confirmation.confirmed_at : null;
        const checks = job ? filingReleaseChecks(job,account) : null;
        const preflightChecks = [
            {id:'bundle',label:'Saved bundle and source PDFs verified',passed:Boolean(checks?.savedBundleVerified && checks.sameAccount && quote?.sourceContentVerified)},
            {id:'primary',label:'Primary account confirmed',passed:Boolean(checks?.primaryAccountConfirmed)},
            {id:'real_case',label:'Not a QA test package',passed:Boolean(checks && !checks.testOnly)},
            {id:'quote',label:'Fresh exact quote and payment account verified',passed:Boolean(quote && !issues.length)},
            {id:'review',label:'Exact amount reviewed for this package',passed:Boolean(reviewedAt)},
            {id:'receipt',label:'Recent Unsubmitted status checked; no prior payment reported',
                passed:Boolean(recentUnsubmitted && !summary.submissionObserved && !receiptEvidenceInvalid)},
        ];
        const preflight = quote ? this.db.prepare(`SELECT created_at FROM mifile_submission_preflights
            WHERE quote_id = ? AND account_identity = ?`).get(quote.id,account.identity) as {created_at:string} | undefined : undefined;
        return {
            inspection: last ? { id: last.id, kind: last.kind, status: last.status, stage: last.stage, createdAt: last.createdAt,
                startedAt: last.startedAt, finishedAt: last.finishedAt, error: last.error } : null,
            active: Boolean(active), quote: publicQuote, issues,
            canConfirm: Boolean(quote && !issues.length),
            canInspect:Boolean(job && filingReleaseChecks(job,account).sameAccount && !summary.submissionObserved && !receiptEvidenceInvalid),
            confirmedAt: reviewedAt,
            checkoutVerified: Boolean(quote && job && latestQuote?.id === quoteInspection?.id &&
                issues.every(issue => /^(Add a payment method|Select the intended payment method|Verify the payment account)/.test(issue))),
            paymentMethodChoice:choice,
            selectedPaymentMethodLabel:publicQuote?.availablePaymentMethods?.find(method => method.fingerprint === quote?.paymentMethodFingerprint)?.label || null,
            preflight:{checks:preflightChecks,complete:preflightChecks.every(check=>check.passed),
                recordedAt:preflightChecks.every(check=>check.passed) ? preflight?.created_at || null : null,
                executionEnabled:false as const},
            outcome:mifileOutcome(receipts,job?.payload?.documents.map(document => document.id) || [],receiptCheck ? {
                status:receiptCheck.status,state:receiptResult?.state || null,checkedAt:receiptResult?.checkedAt || null,
            } : null,receiptEvidenceInvalid,now),
            receipts, receiptSummary:summary, receiptCheckState: receiptResult?.state || null,
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
            this.recordPreflight(filingJobId,account,now);
        });
    }

    private recordPreflight(filingJobId: string, account: CheckoutAccount, now = Date.now()): void {
            const ready = this.state(filingJobId,account,now), quote = ready.quote;
            if (quote && ready.preflight.complete) {
                const rows = this.db.prepare(`SELECT id FROM mifile_checkout_inspections WHERE filing_job_id = ?
                    AND kind = 'quote' AND status = 'completed' ORDER BY created_at DESC, rowid DESC LIMIT 25`)
                    .all(filingJobId) as Array<{id:string}>;
                const fullQuote = rows.map(row => this.get(row.id)?.result)
                    .find(result => result?.kind === 'quote' && result.quote.id === quote.id);
                const privateQuote = fullQuote?.kind === 'quote' ? fullQuote.quote : null;
                if (!privateQuote || privateQuote.totalCents > 0 && !/^[a-f0-9]{64}$/.test(privateQuote.paymentMethodFingerprint || '')) {
                    throw new Error('The reviewed payment account could not be verified. Refresh checkout.');
                }
                const snapshot = {version:1,filingJobId,bundleId:quote.bundleId,quoteId:quote.id,
                    quoteDigest:quote.quoteDigest,packageDigest:quote.packageDigest,totalCents:quote.totalCents,
                    currency:quote.currency,accountIdentity:account.identity,
                    paymentMethodFingerprint:privateQuote.paymentMethodFingerprint,
                    expiresAt:quote.expiresAt,executionKey:digest([account.identity,quote.bundleId]),
                    paymentAuthorized:false,courtSubmissionAuthorized:false};
                this.db.prepare(`INSERT INTO mifile_submission_preflights
                    (quote_id,filing_job_id,account_identity,created_at,snapshot_json) VALUES(?,?,?,?,?) ON CONFLICT(quote_id) DO NOTHING`)
                    .run(quote.id,filingJobId,account.identity,new Date(now).toISOString(),JSON.stringify(snapshot));
            }
    }
}
