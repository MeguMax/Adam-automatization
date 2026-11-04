import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { FilingJobView } from './database';
import { filingReleaseChecks } from './mifilePreparationEvidence';

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

export class DraftNotificationStore {
    constructor(private readonly sql: DatabaseSync, private readonly now = () => new Date().toISOString()) {}

    enqueue(job: FilingJobView, packageLabel: string | null, environment: NodeJS.ProcessEnv = process.env): boolean {
        const config = draftNotificationConfig(environment);
        const checks = filingReleaseChecks(job, null);
        if (!config.ready || !checks.savedBundleVerified || checks.testOnly || !job.payload) return false;
        const parties = [job.payload.filingData?.plaintiff?.displayName,
            Array.isArray(job.payload.filingData?.defendants) ? job.payload.filingData.defendants.map(party => party.displayName).filter(Boolean).join(', ') : null]
            .filter(Boolean).join(' v. ');
        const label = parties || packageLabel || job.temporaryCaseNumber || 'New case';
        const subject = `MiFILE draft ready for review: ${label}`.replace(/[\r\n]+/g, ' ').slice(0, 240);
        const url = `${config.adminUrl}/?draft=${encodeURIComponent(job.caseDraftId)}`;
        const mail = {
            to: config.recipient, subject,
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
        const inserted = this.sql.prepare(`INSERT INTO draft_notifications
            (id,case_draft_id,filing_job_id,status,payload_json,attempts,next_attempt_at,created_at,updated_at)
            VALUES (?,?,?,'pending',?,0,?,?,?) ON CONFLICT(filing_job_id) DO NOTHING`)
            .run(randomUUID(), job.caseDraftId, job.id, JSON.stringify(mail), this.now(), this.now(), this.now());
        return Number(inserted.changes) === 1;
    }

    recover(): number {
        // An interrupted send may already have reached Graph. Never replay it blindly.
        return Number(this.sql.prepare(`UPDATE draft_notifications SET status='uncertain',
            last_error='Email delivery was interrupted; check Sent/recipient before retrying.',updated_at=?
            WHERE status='sending'`).run(this.now()).changes);
    }

    claim(): DraftReadyMail | null {
        const row = this.sql.prepare(`SELECT n.* FROM draft_notifications n JOIN filing_jobs j ON j.id=n.filing_job_id
            JOIN case_drafts c ON c.id=n.case_draft_id WHERE n.status='pending' AND n.next_attempt_at<=?
            AND j.status='prepared' AND c.filing_status='prepared' ORDER BY n.created_at,n.id LIMIT 1`).get(this.now()) as any;
        if (!row) return null;
        const update = this.sql.prepare(`UPDATE draft_notifications SET status='sending',attempts=attempts+1,updated_at=?
            WHERE id=? AND status='pending'`).run(this.now(), row.id);
        if (!update.changes) return null;
        return { id: row.id, draftId: row.case_draft_id, jobId: row.filing_job_id,
            ...JSON.parse(row.payload_json), attempts: Number(row.attempts) + 1 };
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
        return this.sql.prepare(`SELECT status,attempts,last_error AS lastError,sent_at AS sentAt
            FROM draft_notifications WHERE case_draft_id=? ORDER BY created_at DESC LIMIT 1`).get(draftId) || null;
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
        const payload = { ...JSON.parse(row.payload_json), to: config.recipient };
        const updated = this.sql.prepare(`UPDATE draft_notifications SET status='pending',payload_json=?,last_error=NULL,next_attempt_at=?,updated_at=?
            WHERE id=? AND status IN ('failed','uncertain')`).run(JSON.stringify(payload), this.now(), this.now(), row.id);
        if (!updated.changes) throw new Error('The notification changed. Refresh before retrying.');
        this.audit({ id: row.id, draftId, jobId: row.filing_job_id, attempts: Number(row.attempts), ...payload },
            'draft_ready_email_retry_requested', { recipient: config.recipient });
    }

    private audit(mail: DraftReadyMail, action: string, metadata: unknown) {
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
