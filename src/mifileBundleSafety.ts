import type { DatabaseSync } from 'node:sqlite';
import type { FilingJobView } from './database';
import { digest, receiptSummary, validateReceipt, type MiFileReceiptObservation } from './mifileCheckout';

export function bundleExecutionKey(username: string, bundleId: string): string {
    const email = username.trim().toLowerCase(), bundle = bundleId.trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ||
        !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(bundle)) {
        throw new Error('A verified MiFILE account and bundle ID are required.');
    }
    return digest(['mifile-bundle-v2', email, bundle]);
}

export function rememberBundleActivity(db: DatabaseSync, observation: MiFileReceiptObservation, filingJobId: string): void {
    if (!receiptSummary([observation]).submissionObserved) return;
    db.prepare(`INSERT INTO mifile_bundle_activity
        (execution_key, account_email, bundle_id, observed_at, source_filing_job_id, evidence_json)
        VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(execution_key) DO NOTHING`)
        .run(bundleExecutionKey(observation.accountEmail, observation.bundleId), observation.accountEmail,
            observation.bundleId, observation.observedAt, filingJobId, JSON.stringify(observation));
}

// These small safety records intentionally survive deletion of local drafts and receipt history.
export function migrateBundleActivity(db: DatabaseSync): void {
    const rows = db.prepare(`SELECT e.event_json, e.document_id, e.filing_job_id,
        j.external_bundle_id, j.result_json FROM mifile_receipt_events e JOIN filing_jobs j ON j.id = e.filing_job_id`).all() as
        Array<{event_json:string;document_id:string;filing_job_id:string;external_bundle_id:string|null;result_json:string|null}>;
    for (const row of rows) {
        let observation: MiFileReceiptObservation | undefined, savedAccount: string | undefined;
        try { observation = JSON.parse(row.event_json); } catch { /* Retain a hold if its saved account can be recovered. */ }
        try { savedAccount = JSON.parse(row.result_json || '{}').savedBundleEvidence?.accountEmail; } catch { /* Use receipt identity below. */ }
        const email = savedAccount || observation?.accountEmail, bundle = row.external_bundle_id || observation?.bundleId;
        if (!email || !bundle) continue;
        let key: string;
        try { key = bundleExecutionKey(email,bundle); } catch { continue; }
        try {
            const job = {externalBundleId:bundle,payload:{documents:[{id:row.document_id}]}} as FilingJobView;
            if (!observation) throw new Error('Unreadable historical receipt');
            validateReceipt(observation,job,{username:email,identity:'migration',accountEnvironment:'',productionConfirmed:false});
            rememberBundleActivity(db,observation,row.filing_job_id);
            continue;
        } catch {
            // Malformed historical evidence must not silently clear a potential prior transaction.
            db.prepare(`INSERT INTO mifile_bundle_activity
                (execution_key, account_email, bundle_id, observed_at, source_filing_job_id, evidence_json)
                VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(execution_key) DO NOTHING`)
                .run(key,email.trim().toLowerCase(),bundle.trim().toLowerCase(),
                    new Date().toISOString(),row.filing_job_id,row.event_json);
        }
    }
}
