import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { WorkflowDatabase, type FilingJobView, type FilingPayload } from './database';
import { buildFilingIntake } from './filingIntake';
import { preparationDigest } from './mifilePreparationEvidence';
import { deliverDraftNotifications, draftNotificationConfig, DraftNotificationStore } from './draftNotifications';

const environment = { DRAFT_READY_NOTIFY_EMAIL: 'adam@example.com', SENDER_USER_ID: 'sender@example.com',
    ADMIN_PUBLIC_URL: 'https://workflow.example', DRAFT_READY_NOTIFICATIONS_ENABLED: 'true' };

function fixture() {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'draft-notifications-'));
    const db = new WorkflowDatabase(path.join(directory, 'workflow.sqlite'));
    const sql = (db as any).db;
    const msg = { id: 'ready-notification', subject: 'NEW LT FILING - Example', receivedDateTime: new Date().toISOString() };
    const email = db.registerEmail(msg), draftId = db.createCaseDraft(email.id, buildFilingIntake(msg, []));
    const bundle = 'fd2c1ad4-633d-429a-0166-08df32c555de';
    const payload = { version: 1, caseDraftId: draftId, emailId: email.id, subject: msg.subject, courtName: '17th District Court',
        filingData: { plaintiff: { displayName: 'Example Property LLC' }, defendants: [{ displayName: 'Morgan Example' }] },
        documents: [
            { id: 'complaint', filingName: 'Complaint.pdf', filingType: 'Complaint for Possession Only', filingRelation: 'separate', isPrimary: true },
            { id: 'support', filingName: 'Demand.pdf', filingType: 'Other', filingRelation: 'connected_to_complaint', isPrimary: false },
        ] } as unknown as FilingPayload;
    const sources = payload.documents.map(document => ({ documentId: document.id, sha256: 'ab'.repeat(32), bytes: 500 }));
    const result = { url: 'https://mifile.courts.michigan.gov/filing/create/' + bundle,
        documentManifest: payload.documents.map(document => ({ documentId: document.id, filingName: document.filingName,
            filingType: document.isPrimary ? document.filingType : 'CONNECTED FILING', filingRelation: document.filingRelation,
            parentDocumentId: document.isPrimary ? null : 'complaint' })),
        savedBundleEvidence: { version: 1, verifiedAt: new Date().toISOString(), externalBundleId: bundle,
            temporaryCaseNumber: 'TEMP-READY', accountEmail: 'account@example.com', filer: 'Devlin, Adam (P72877)',
            courtName: payload.courtName, sourcePdfCount: 2, connectedPdfCount: 1, generatedPdfCount: 1,
            packageDigest: preparationDigest(payload, sources), sources, paymentAuthorized: false, courtSubmissionAuthorized: false } };
    const job = { id: 'job-ready', caseDraftId: draftId, status: 'prepared', payload, result,
        externalBundleId: bundle, temporaryCaseNumber: 'TEMP-READY' } as unknown as FilingJobView;
    sql.prepare(`INSERT INTO filing_jobs(id,case_draft_id,attempt_number,mode,status,payload_json,created_at,updated_at)
        VALUES (?,?,1,'prepare','prepared',?,?,?)`).run(job.id, draftId, JSON.stringify(payload), new Date().toISOString(), new Date().toISOString());
    db.setCaseDraftStatus(draftId, 'filing_prepared', 'passed', 'prepared');
    let clock = Date.now();
    const store = new DraftNotificationStore(sql, () => new Date(clock).toISOString());
    return { db, sql, store, job, draftId, advance(ms: number) { clock += ms; },
        close() { db.close(); fs.rmSync(directory, { recursive: true, force: true }); } };
}

test('only verified saved packages enqueue a notification; QA, partial, disabled and malformed configurations cannot announce readiness', () => {
    const f = fixture();
    try {
        for (const job of [ { ...f.job, status: 'failed' }, { ...f.job, result: null },
            { ...f.job, payload: { ...f.job.payload!, subject: 'NEW LT FILING - QA no mail' } },
            { ...f.job, result: { ...f.job.result, savedBundleEvidence: { ...(f.job.result!.savedBundleEvidence as any), sourcePdfCount: 1 } } },
        ]) assert.equal(f.store.enqueue(job as FilingJobView, 'Example M', environment), false);
        assert.equal(f.store.enqueue(f.job, 'Example M', { ...environment, DRAFT_READY_NOTIFICATIONS_ENABLED: 'false' }), false);
        assert.equal(f.store.enqueue(f.job, 'Example M', { ...environment, ADMIN_PUBLIC_URL: 'http://localhost:3000' }), false);
        assert.equal(draftNotificationConfig({ ...environment, DRAFT_READY_NOTIFY_EMAIL: 'a@example.com\nBcc: bad@example.com' }).ready, false);
        assert.equal(f.store.enqueue(f.job, 'Example M', environment), true);
        assert.equal(f.store.enqueue(f.job, 'Example M', environment), false);
        const mail = f.store.claim()!;
        assert.equal(mail.to, 'adam@example.com'); assert.match(mail.bodyText, /Unsubmitted/);
        assert.ok(mail.bodyText.includes('/?draft=' + f.draftId));
        assert.match(mail.bodyText, /Connected to Complaint: 1/);
        assert.match(mail.bodyText, /No payment or court submission was made/);
        assert.equal(f.store.claim(), null);
    } finally { f.close(); }
});

test('successful delivery is durable and idempotent across re-enqueue, polling and database reopen', async () => {
    const f = fixture();
    try {
        f.store.enqueue(f.job, 'Example M', environment);
        let sends = 0;
        await deliverDraftNotifications(f.store, async () => { sends++; });
        await deliverDraftNotifications(f.store, async () => { sends++; });
        assert.equal(sends, 1);
        assert.equal((f.store.forDraft(f.draftId) as any).status, 'sent');
        const reopened = new WorkflowDatabase(f.db.getPath());
        try { assert.equal(reopened.draftNotifications().enqueue(f.job, 'Example M', environment), false); assert.equal(reopened.draftNotifications().claim(), null); }
        finally { reopened.close(); }
        assert.ok(f.db.getDraftDetail(f.draftId)!.auditLogs.some(log => log.action === 'draft_ready_email_sent'));
    } finally { f.close(); }
});

test('throttling gets bounded delayed retry; unknown delivery and interrupted sends are never blindly repeated', async () => {
    const f = fixture();
    try {
        f.store.enqueue(f.job, null, environment);
        let sends = 0;
        await deliverDraftNotifications(f.store, async () => { sends++; throw { statusCode: 429 }; });
        assert.equal(sends, 1); assert.equal(f.store.claim(), null);
        f.advance(61_000);
        await deliverDraftNotifications(f.store, async () => { sends++; throw new Error('Timeout after Graph accepted request'); });
        assert.equal(sends, 2); assert.equal((f.store.forDraft(f.draftId) as any).status, 'uncertain');
        f.advance(3_600_000);
        await deliverDraftNotifications(f.store, async () => { sends++; });
        assert.equal(sends, 2);
        f.sql.prepare("UPDATE draft_notifications SET status='sending'").run();
        assert.equal(f.store.recover(), 1); assert.equal(f.store.recover(), 0); assert.equal(f.store.claim(), null);
    } finally { f.close(); }
});

test('filing completion and its outbox record commit together and a notification failure cannot change package status', () => {
    const f = fixture();
    const previous = Object.fromEntries(Object.keys(environment).map(key => [key, process.env[key]]));
    try {
        Object.assign(process.env, environment);
        const complete = () => f.db.completeFilingJob({ filingJobId: f.job.id, status: 'prepared', checkpoint: 'saved_unsubmitted',
            externalBundleId: f.job.externalBundleId, temporaryCaseNumber: f.job.temporaryCaseNumber, result: f.job.result });
        complete(); complete();
        assert.equal((f.store.summary()[0] as any).count, 1);
        f.advance(10_000);
        const mail = f.store.claim()!; f.store.fail(mail, { statusCode: 403 });
        assert.equal((f.store.forDraft(f.draftId) as any).status, 'failed');
        assert.equal(f.db.getDraftDetail(f.draftId)!.caseDraft!.filingStatus, 'prepared');
    } finally {
        for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
        f.close();
    }
});

test('an uncertain ready email needs explicit non-delivery confirmation to retry and cannot resend after it was accepted', async () => {
    const f = fixture();
    try {
        f.store.enqueue(f.job, null, environment);
        await deliverDraftNotifications(f.store, async () => { throw new Error('Unknown outcome'); });
        assert.throws(() => f.store.retry(f.draftId, false, environment), /confirm/);
        f.store.retry(f.draftId, true, environment);
        assert.throws(() => f.store.retry(f.draftId, true, environment), /no failed notification/);
        let sends = 0;
        await deliverDraftNotifications(f.store, async () => { sends++; });
        assert.equal(sends, 1);
        assert.throws(() => f.store.retry(f.draftId, true, environment), /no failed notification/);
    } finally { f.close(); }
});
