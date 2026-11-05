import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { FilingJobView } from './database';
import { filingReleaseChecks, type MiFileSavedBundleEvidence } from './mifilePreparationEvidence';
import { bundleExecutionKey } from './mifileBundleSafety';
import { receiptSummary, validateReceipt } from './mifileCheckout';

export function draftNotificationConfig(environment: NodeJS.ProcessEnv = process.env) {
    const enabled = !['false', '0', 'off', 'no'].includes((environment.DRAFT_READY_NOTIFICATIONS_ENABLED || 'true').trim().toLowerCase());
    const recipient = (environment.DRAFT_READY_NOTIFY_EMAIL || environment.NOTIFY_TO_EMAIL || '').trim();
    let adminUrl = '';
    try {
        const url = new URL(environment.ADMIN_PUBLIC_URL || environment.RENDER_EXTERNAL_URL || '');
        if (url.protocol === 'https:' && !url.username && !url.password) adminUrl = url.origin;
    } catch { /* A missing public URL must not produce a localhost email link. */ }
    const ready = enabled && /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(recipient) && Boolean(adminUrl && environment.SENDER_USER_ID);
    return { enabled, ready, recipient, adminUrl };
}

export interface DraftReadyMail {
    id: string;
    draftId: string;
    jobId: string;
    to: string;
    subject: string;
    bodyText: string;
    attempts: number;
}

interface ReadySnapshot {
    version: 1;
    executionKey: string;
    bundleId: string;
    packageDigest: string;
    temporaryCaseNumber: string;
}

type NotificationRow = {
    id:string;case_draft_id:string;filing_job_id:string;status:string;payload_json:string;
    attempts:number;created_at:string;next_attempt_at:string;last_error:string|null;sent_at:string|null;
};

function readySnapshot(job:FilingJobView):ReadySnapshot|null {
    const checks=filingReleaseChecks(job,null);
    if(!checks.savedBundleVerified || checks.testOnly)return null;
    const evidence=job.result!.savedBundleEvidence as MiFileSavedBundleEvidence;
    try {
        return {version:1,executionKey:bundleExecutionKey(evidence.accountEmail,evidence.externalBundleId),
            bundleId:evidence.externalBundleId,packageDigest:evidence.packageDigest,
            temporaryCaseNumber:evidence.temporaryCaseNumber};
    }catch{return null;}
}

export class DraftNotificationStore {
    constructor(private readonly sql: DatabaseSync, private readonly now = () => new Date().toISOString()) {}

    enqueue(job: FilingJobView, packageLabel: string | null, environment: NodeJS.ProcessEnv = process.env): boolean {
        const config = draftNotificationConfig(environment);
        const snapshot=readySnapshot(job),current=this.job(job.id);
        if(!config.ready || !snapshot || !current || JSON.stringify(readySnapshot(current))!==JSON.stringify(snapshot) ||
            this.readinessIssue(current))return false;
        const mail=this.buildMail(job,packageLabel,config);
        if(this.sql.prepare('SELECT 1 FROM draft_notifications WHERE filing_job_id=?').get(job.id))return false;
        // A newer verification may replace an unsent notice, never a sent or uncertain one.
        const refreshed=this.sql.prepare(`UPDATE draft_notifications SET filing_job_id=?,payload_json=?,attempts=0,
            last_error=NULL,next_attempt_at=?,updated_at=? WHERE id=(
                SELECT n.id FROM draft_notifications n JOIN filing_jobs j ON j.id=n.filing_job_id
                WHERE n.case_draft_id=? AND n.status='pending' AND lower(j.external_bundle_id)=?
                  AND NOT EXISTS(SELECT 1 FROM draft_notifications other JOIN filing_jobs prior ON prior.id=other.filing_job_id
                    WHERE other.id!=n.id AND other.status IN ('sending','sent','uncertain') AND lower(prior.external_bundle_id)=?)
                ORDER BY n.created_at,n.id LIMIT 1) RETURNING id`)
            .get(job.id,JSON.stringify(mail),this.now(),this.now(),job.caseDraftId,snapshot.bundleId,snapshot.bundleId) as {id:string}|undefined;
        if(refreshed) {
            this.audit({id:refreshed.id,draftId:job.caseDraftId},'draft_ready_email_refreshed',{filingJobId:job.id});
            return true;
        }
        const inserted = this.sql.prepare(`INSERT INTO draft_notifications
            (id,case_draft_id,filing_job_id,status,payload_json,attempts,next_attempt_at,created_at,updated_at)
            SELECT ?,?,?,'pending',?,0,?,?,? WHERE NOT EXISTS (
                SELECT 1 FROM draft_notifications n JOIN filing_jobs j ON j.id=n.filing_job_id
                WHERE n.status IN ('pending','sending','sent','uncertain') AND (
                    json_extract(CASE WHEN json_valid(n.payload_json) THEN n.payload_json ELSE '{}' END,'$.readySnapshot.executionKey')=?
                    OR lower(j.external_bundle_id)=?)) ON CONFLICT(filing_job_id) DO NOTHING`)
            .run(randomUUID(),job.caseDraftId,job.id,JSON.stringify(mail),this.now(),this.now(),this.now(),snapshot.executionKey,snapshot.bundleId);
        return Number(inserted.changes)===1;
    }

    private buildMail(job:FilingJobView,packageLabel:string|null,config:ReturnType<typeof draftNotificationConfig>) {
        if(!job.payload)throw new Error('The verified package payload is missing.');
        const parties = [job.payload.filingData?.plaintiff?.displayName,
            Array.isArray(job.payload.filingData?.defendants) ? job.payload.filingData.defendants.map(party => party.displayName).filter(Boolean).join(', ') : null]
            .filter(Boolean).join(' v. ');
        const label = parties || packageLabel || job.temporaryCaseNumber || 'New case';
        const subject = `MiFILE draft ready for review: ${label}`.replace(/[\r\n]+/g, ' ').slice(0, 240);
        const url = `${config.adminUrl}/?draft=${encodeURIComponent(job.caseDraftId)}`;
        return {
            to:config.recipient,subject,packageLabel,readySnapshot:readySnapshot(job),
            bodyText: [
                'Your case package has been saved and checked in MiFILE History > Unsubmitted.',
                '', `Case: ${label}`, `Court: ${job.payload.courtName}`,
                `Temporary case: ${job.temporaryCaseNumber}`,
                `PDFs: ${job.payload.documents.length} source documents, plus the MiFILE Case Initiation Form`,
                `Connected to Complaint: ${job.payload.documents.filter(document => document.filingRelation === 'connected_to_complaint').length}`,
                ...(packageLabel ? [`Email package: ${packageLabel}`] : []),
                `Source email: ${job.payload.subject || '(no subject)'}`,
                '', `Review in the admin panel: ${url}`,
                'Open MiFILE History > Unsubmitted to review the saved package before filing.',
                '', 'No payment or court submission was made by the automation. This message is not a filing receipt.',
            ].join('\n'),
        };
    }

    private job(id:string):FilingJobView|null {
        const row=this.sql.prepare('SELECT * FROM filing_jobs WHERE id=?').get(id) as any;
        if(!row)return null;
        try {
            return {id:row.id,caseDraftId:row.case_draft_id,status:row.status,
                externalBundleId:row.external_bundle_id,temporaryCaseNumber:row.temporary_case_number,
                payload:JSON.parse(row.payload_json),result:JSON.parse(row.result_json)} as FilingJobView;
        }catch{return null;}
    }

    private readinessIssue(job:FilingJobView):string|null {
        const snapshot=readySnapshot(job);
        if(!snapshot)return 'The saved MiFILE package is no longer verified. Check the package before notifying the reviewer.';
        const draft=this.sql.prepare('SELECT status,filing_status,normalized_data_json FROM case_drafts WHERE id=?')
            .get(job.caseDraftId) as any;
        if(draft?.status!=='filing_prepared' || draft.filing_status!=='prepared')return 'The case is no longer a prepared Unsubmitted package.';
        const latest=this.sql.prepare('SELECT id FROM filing_jobs WHERE case_draft_id=? ORDER BY attempt_number DESC,created_at DESC,id DESC LIMIT 1')
            .get(job.caseDraftId) as {id:string}|undefined;
        if(latest?.id!==job.id)return 'A newer MiFILE preparation exists for this case. The older ready email will not be sent.';
        try {
            const root=JSON.parse(draft.normalized_data_json);
            if(root.complaintExtractionError || ['queued','running'].includes(root.complaintAutoExtraction?.status) || root.intake?.processingError)
                return 'Document reading or package correction is not complete. No ready email was sent.';
            const documents=this.sql.prepare(`SELECT d.id,d.status,d.one_drive_url,d.file_size,d.metadata_json,f.sha256 AS library_hash
                FROM document_records d LEFT JOIN filing_forms f ON f.id=json_extract(d.metadata_json,'$.formTemplate.id')
                WHERE d.case_draft_id=? AND d.is_active=1 AND d.required_for_filing=1`).all(job.caseDraftId) as any[];
            const evidence=job.result!.savedBundleEvidence as MiFileSavedBundleEvidence;
            if(documents.length!==job.payload!.documents.length || documents.some(document=>{
                const metadata=JSON.parse(document.metadata_json || '{}');
                const version=JSON.stringify([document.id,document.one_drive_url,document.file_size,
                    metadata.replacement?.token || metadata.lastReplacement?.token || null]);
                return !['uploaded','downloaded','replaced'].includes(document.status) || !document.one_drive_url ||
                    metadata.recognitionRecovery?.sourceVersion===version ||
                    !evidence.sources.some(source=>source.documentId===document.id && source.bytes===document.file_size &&
                        source.sha256===(metadata.recognition?.contentHash || document.library_hash));
            }))return 'The current PDFs no longer match the verified package or still need verification. No ready email was sent.';
            const key=snapshot.executionKey;
            if(this.sql.prepare('SELECT 1 FROM mifile_bundle_activity WHERE execution_key=?').get(key) ||
                this.sql.prepare(`SELECT 1 FROM mifile_submission_intents WHERE execution_key=?
                    AND (attempt_count>0 OR status='reconciliation_required')`).get(key))
                return 'MiFILE payment or submission activity needs checking. A ready-to-file email will not be sent.';
            const account={username:(job.result!.savedBundleEvidence as MiFileSavedBundleEvidence).accountEmail,
                identity:'notification-check',accountEnvironment:'',productionConfirmed:false};
            const receipts=this.sql.prepare('SELECT event_json FROM mifile_receipt_events WHERE filing_job_id=?').all(job.id) as Array<{event_json:string}>;
            for(const row of receipts) {
                const receipt=JSON.parse(row.event_json);
                validateReceipt(receipt,job,account);
                if(receiptSummary([receipt]).submissionObserved)return 'MiFILE already reports payment or filing activity. No Unsubmitted-ready email was sent.';
            }
        }catch{return 'Stored package or receipt evidence could not be verified. Check MiFILE before notifying the reviewer.';}
        return null;
    }

    private duplicate(row:NotificationRow,job:FilingJobView,earlierPendingOnly=false):boolean {
        const snapshot=readySnapshot(job);
        if(!snapshot)return true;
        return Boolean(this.sql.prepare(`SELECT 1 FROM draft_notifications n JOIN filing_jobs j ON j.id=n.filing_job_id
            WHERE n.id!=? AND n.status IN ('pending','sending','sent','uncertain')
              AND (n.status!='pending' OR ?=0 OR n.created_at<? OR (n.created_at=? AND n.id<?))
              AND (json_extract(CASE WHEN json_valid(n.payload_json) THEN n.payload_json ELSE '{}' END,'$.readySnapshot.executionKey')=?
                OR lower(j.external_bundle_id)=?) LIMIT 1`)
            .get(row.id,earlierPendingOnly?1:0,row.created_at,row.created_at,row.id,snapshot.executionKey,snapshot.bundleId));
    }

    private queuedIssue(row:NotificationRow,job:FilingJobView|null,requireSnapshot=true):string|null {
        if(!job || job.caseDraftId!==row.case_draft_id)return 'The prepared package is unavailable. No ready email was sent.';
        const issue=this.readinessIssue(job);
        if(issue)return issue;
        if(this.duplicate(row,job,requireSnapshot))return 'Another notification for this MiFILE bundle is queued, sent or has an uncertain delivery. Check the inbox before resending.';
        if(requireSnapshot) {
            try {
                const payload=JSON.parse(row.payload_json);
                if(JSON.stringify(payload.readySnapshot)!==JSON.stringify(readySnapshot(job)))
                    return 'The queued email no longer matches the verified package. Review the package before retrying the notification.';
                if(typeof payload.subject!=='string' || typeof payload.bodyText!=='string' ||
                    !/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(payload.to))throw new Error('Invalid queued email');
            }catch{return 'The queued notification could not be verified. No email was sent.';}
        }
        return null;
    }

    recover(): number {
        // An interrupted send may already have reached Graph. Never replay it blindly.
        return Number(this.sql.prepare(`UPDATE draft_notifications SET status='uncertain',
            last_error='Email delivery was interrupted; check Sent/recipient before retrying.',updated_at=?
            WHERE status='sending'`).run(this.now()).changes);
    }

    claim(): DraftReadyMail | null {
        const rows=this.sql.prepare(`SELECT * FROM draft_notifications WHERE status='pending' AND next_attempt_at<=?
            ORDER BY created_at,id LIMIT 20`).all(this.now()) as unknown as NotificationRow[];
        for(const row of rows) {
            const issue=this.queuedIssue(row,this.job(row.filing_job_id));
            if(issue) {
                this.sql.prepare("UPDATE draft_notifications SET status='failed',last_error=?,updated_at=? WHERE id=? AND status='pending'")
                    .run(issue,this.now(),row.id);
                this.audit({id:row.id,draftId:row.case_draft_id},'draft_ready_email_suppressed',{reason:issue});
                continue;
            }
            const update = this.sql.prepare(`UPDATE draft_notifications SET status='sending',attempts=attempts+1,updated_at=?
                WHERE id=? AND status='pending'`).run(this.now(), row.id);
            if (!update.changes) continue;
            return { id: row.id, draftId: row.case_draft_id, jobId: row.filing_job_id,
                ...JSON.parse(row.payload_json), attempts: Number(row.attempts) + 1 };
        }
        return null;
    }

    sent(mail: DraftReadyMail): void {
        const timestamp = this.now();
        this.sql.prepare(`UPDATE draft_notifications SET status='sent',last_error=NULL,sent_at=?,updated_at=?
            WHERE id=? AND status='sending'`).run(timestamp, timestamp, mail.id);
        this.audit(mail, 'draft_ready_email_sent', { recipient: mail.to });
    }

    fail(mail: DraftReadyMail, error: unknown): void {
        const statusCode = Number((error as any)?.statusCode || (error as any)?.status || 0);
        const retry = statusCode === 429 && mail.attempts < 3;
        const status = retry ? 'pending' : statusCode >= 400 && statusCode < 500 ? 'failed' : 'uncertain';
        const message = retry ? 'Microsoft throttled email sending; another attempt is scheduled.' :
            status === 'failed' ? `Microsoft rejected the notification (HTTP ${statusCode}). Check email sending settings.` :
                'Email delivery could not be confirmed. Check the recipient before retrying to avoid a duplicate notification.';
        this.sql.prepare(`UPDATE draft_notifications SET status=?,last_error=?,next_attempt_at=?,updated_at=?
            WHERE id=? AND status='sending'`).run(status, message,
                new Date(Date.parse(this.now()) + 60_000 * mail.attempts).toISOString(), this.now(), mail.id);
        this.audit(mail, 'draft_ready_email_delivery_issue', { status, message });
    }

    forDraft(draftId: string) {
        const row=this.sql.prepare('SELECT * FROM draft_notifications WHERE case_draft_id=? ORDER BY created_at DESC,rowid DESC LIMIT 1')
            .get(draftId) as NotificationRow|undefined;
        if(!row)return null;
        const issue=['pending','failed','uncertain'].includes(row.status) ? this.queuedIssue(row,this.job(row.filing_job_id),false) : null;
        let recipient:string|null=null;
        try{recipient=JSON.parse(row.payload_json).to || null;}catch{/* Show the stored delivery issue instead. */}
        return {status:row.status,attempts:row.attempts,lastError:issue || row.last_error,sentAt:row.sent_at,
            nextAttemptAt:row.status==='pending'?row.next_attempt_at:null,recipient,
            canRetry:['failed','uncertain'].includes(row.status) && !issue};
    }

    summary() {
        return this.sql.prepare(`SELECT status,COUNT(*) AS count FROM draft_notifications GROUP BY status`).all();
    }

    retry(draftId: string, confirmedNotDelivered: boolean, environment: NodeJS.ProcessEnv = process.env): void {
        const config = draftNotificationConfig(environment);
        if (!config.ready || !confirmedNotDelivered) throw new Error('Check the recipient and Sent items, then confirm the email was not delivered. Sending must be configured.');
        const row = this.sql.prepare(`SELECT n.* FROM draft_notifications n JOIN filing_jobs j ON j.id=n.filing_job_id
            JOIN case_drafts c ON c.id=n.case_draft_id WHERE n.case_draft_id=? AND n.status IN ('failed','uncertain')
            AND j.status='prepared' AND c.filing_status='prepared' ORDER BY n.created_at DESC LIMIT 1`).get(draftId) as any;
        if (!row) throw new Error('There is no failed notification to retry for this prepared package');
        const job=this.job(row.filing_job_id),issue=this.queuedIssue(row,job,false);
        if(issue)throw new Error(issue);
        let packageLabel:string|null=null;
        try{packageLabel=JSON.parse(row.payload_json).packageLabel || null;}catch{/* Regenerate malformed mail from verified data. */}
        const payload=this.buildMail(job!,packageLabel,config);
        const updated = this.sql.prepare(`UPDATE draft_notifications SET status='pending',payload_json=?,last_error=NULL,next_attempt_at=?,updated_at=?
            WHERE id=? AND status IN ('failed','uncertain')`).run(JSON.stringify(payload), this.now(), this.now(), row.id);
        if (!updated.changes) throw new Error('The notification changed. Refresh before retrying.');
        this.audit({ id: row.id, draftId },
            'draft_ready_email_retry_requested', { recipient: config.recipient });
    }

    private audit(mail: Pick<DraftReadyMail,'id'|'draftId'>, action: string, metadata: unknown) {
        this.sql.prepare(`INSERT INTO audit_logs(id,entity_type,entity_id,action,actor_type,metadata_json,created_at)
            VALUES (?,'case_draft',?,?,'system',?,?)`)
            .run(randomUUID(), mail.draftId, action, JSON.stringify({ notificationId: mail.id, ...metadata as object }), this.now());
    }
}

export async function deliverDraftNotifications(store: DraftNotificationStore, send: (mail: DraftReadyMail) => Promise<void>, limit = 3) {
    for (let index = 0; index < limit; index++) {
        const mail = store.claim();
        if (!mail) break;
        try { await send(mail); store.sent(mail); }
        catch (error) { store.fail(mail, error); }
    }
}
