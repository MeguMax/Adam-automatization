import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { WorkflowDatabase, type FilingJobView, type FilingPayload } from './database';
import { buildFilingIntake } from './filingIntake';
import { preparationDigest } from './mifilePreparationEvidence';
import { deliverDraftNotifications, draftNotificationConfig, DraftNotificationStore } from './draftNotifications';
import { bundleExecutionKey } from './mifileBundleSafety';

const environment = { DRAFT_READY_NOTIFY_EMAIL: 'adam@example.com', SENDER_USER_ID: 'sender@example.com',
    ADMIN_PUBLIC_URL: 'https://workflow.example', DRAFT_READY_NOTIFICATIONS_ENABLED: 'true' };

function fixture() {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'draft-notifications-'));
    const db = new WorkflowDatabase(path.join(directory, 'workflow.sqlite'));
    const sql = (db as any).db;
    const msg = { id: 'ready-notification', subject: 'NEW LT FILING - Example', receivedDateTime: new Date().toISOString() };
    const email = db.registerEmail(msg), draftId = db.createCaseDraft(email.id, buildFilingIntake(msg, []));
    const complaintId=db.addDocument({emailId:email.id,caseDraftId:draftId,documentType:'Complaint',status:'uploaded',uploadSource:'email_intake',
        originalFilename:'Complaint.pdf',oneDriveUrl:'https://onedrive.example/complaint',fileSize:500,
        metadata:{recognition:{role:'complaint',source:'content',contentHash:'ab'.repeat(32),recognitionVersion:2,pdfVerified:true}}});
    const supportingId=db.addDocument({emailId:email.id,caseDraftId:draftId,documentType:'Other',status:'uploaded',uploadSource:'email_intake',
        originalFilename:'Demand.pdf',oneDriveUrl:'https://onedrive.example/demand',fileSize:500,
        metadata:{recognition:{role:'ancillary',source:'content',contentHash:'ab'.repeat(32),recognitionVersion:2,pdfVerified:true}}});
    const bundle = 'fd2c1ad4-633d-429a-0166-08df32c555de';
    const payload = { version: 1, caseDraftId: draftId, emailId: email.id, subject: msg.subject, courtName: '17th District Court',
        filingData: { plaintiff: { displayName: 'Example Property LLC' }, defendants: [{ displayName: 'Morgan Example' }] },
        documents: [
            { id: complaintId, filingName: 'Complaint.pdf', filingType: 'Complaint for Possession Only', filingRelation: 'separate', isPrimary: true },
            { id: supportingId, filingName: 'Demand.pdf', filingType: 'Other', filingRelation: 'connected_to_complaint', isPrimary: false },
        ] } as unknown as FilingPayload;
    const sources = payload.documents.map(document => ({ documentId: document.id, sha256: 'ab'.repeat(32), bytes: 500 }));
    const result = { url: 'https://mifile.courts.michigan.gov/filing/create/' + bundle,
        documentManifest: payload.documents.map(document => ({ documentId: document.id, filingName: document.filingName,
            filingType: document.isPrimary ? document.filingType : 'CONNECTED FILING', filingRelation: document.filingRelation,
            parentDocumentId: document.isPrimary ? null : complaintId })),
        savedBundleEvidence: { version: 1, verifiedAt: new Date().toISOString(), externalBundleId: bundle,
            temporaryCaseNumber: 'TEMP-READY', accountEmail: 'account@example.com', filer: 'Devlin, Adam (P72877)',
            courtName: payload.courtName, sourcePdfCount: 2, connectedPdfCount: 1, generatedPdfCount: 1,
            packageDigest: preparationDigest(payload, sources), sources, paymentAuthorized: false, courtSubmissionAuthorized: false } };
    const job = { id: 'job-ready', caseDraftId: draftId, status: 'prepared', payload, result,
        externalBundleId: bundle, temporaryCaseNumber: 'TEMP-READY' } as unknown as FilingJobView;
    sql.prepare(`INSERT INTO filing_jobs(id,case_draft_id,attempt_number,mode,status,payload_json,result_json,external_bundle_id,temporary_case_number,created_at,updated_at)
        VALUES (?,?,1,'prepare','prepared',?,?,?,?,?,?)`).run(job.id,draftId,JSON.stringify(payload),JSON.stringify(result),bundle,'TEMP-READY',new Date().toISOString(),new Date().toISOString());
    db.setCaseDraftStatus(draftId, 'filing_prepared', 'passed', 'prepared');
    let clock = Date.now();
    const store = new DraftNotificationStore(sql, () => new Date(clock).toISOString());
    return { db, sql, store, job, draftId, advance(ms: number) { clock += ms; },
        close() { db.close(); fs.rmSync(directory, { recursive: true, force: true }); } };
}

function secondJob(f:ReturnType<typeof fixture>,sameBundle=true) {
    const bundle=sameBundle?f.job.externalBundleId!:'a12c1ad4-633d-429a-0166-08df32c555de';
    const result=structuredClone(f.job.result!);
    result.url='https://mifile.courts.michigan.gov/filing/create/'+bundle;
    (result.savedBundleEvidence as any).externalBundleId=bundle;
    const job={...f.job,id:'job-ready-second',externalBundleId:bundle,result};
    f.sql.prepare(`INSERT INTO filing_jobs(id,case_draft_id,attempt_number,mode,status,payload_json,result_json,external_bundle_id,temporary_case_number,created_at,updated_at)
        VALUES (?,?,2,'prepare','prepared',?,?,?,?,?,?)`).run(job.id,f.draftId,JSON.stringify(job.payload),JSON.stringify(result),
            bundle,job.temporaryCaseNumber,new Date().toISOString(),new Date().toISOString());
    return job;
}

function receipt(f:ReturnType<typeof fixture>,status='Paid') {
    return {bundleId:f.job.externalBundleId,accountEmail:'account@example.com',source:'mifile_history',
        externalReference:'receipt-qa',documentId:null,kind:status==='Unsubmitted'?'bundle_status':'payment',status,
        observedAt:new Date().toISOString(),occurredAt:null,totalCents:status==='Unsubmitted'?null:12000,
        currency:status==='Unsubmitted'?null:'USD',receiptUrl:null};
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

test('an outdated or partially verified queued package is suppressed before delivery without changing the filing job',async()=>{
    const f=fixture();
    try {
        assert.equal(f.store.enqueue(f.job,null,environment),true);
        const changed=structuredClone(f.job.result!);
        (changed.savedBundleEvidence as any).sourcePdfCount=1;
        f.sql.prepare('UPDATE filing_jobs SET result_json=? WHERE id=?').run(JSON.stringify(changed),f.job.id);
        let sends=0;await deliverDraftNotifications(f.store,async()=>{sends++;});
        assert.equal(sends,0);assert.equal(f.store.forDraft(f.draftId)!.status,'failed');
        assert.equal(f.store.forDraft(f.draftId)!.canRetry,false);
        assert.equal(f.db.getFilingJob(f.job.id)!.status,'prepared');
        assert.ok(f.db.getDraftDetail(f.draftId)!.auditLogs.some(log=>log.action==='draft_ready_email_suppressed'));
    }finally{f.close();}
});

test('queued ready mail is suppressed while a PDF is being read or no longer matches its saved fingerprint',async()=>{
    for(const change of ['reading','changed_hash','missing_pdf','failed_upload']) {
        const f=fixture();
        try {
            f.store.enqueue(f.job,null,environment);
            const document=f.db.getDraftDetail(f.draftId)!.documents[0];
            if(change==='reading')f.sql.prepare(`UPDATE document_records SET metadata_json=json_set(metadata_json,
                '$.recognitionRecovery',json(?)) WHERE id=?`).run(JSON.stringify({sourceVersion:document.sourceVersion,status:'reading',attempts:1}),document.id);
            if(change==='changed_hash')f.sql.prepare("UPDATE document_records SET metadata_json=json_set(metadata_json,'$.recognition.contentHash',?) WHERE id=?")
                .run('cd'.repeat(32),document.id);
            if(change==='missing_pdf')f.sql.prepare('UPDATE document_records SET is_active=0 WHERE id=?').run(document.id);
            if(change==='failed_upload')f.sql.prepare("UPDATE document_records SET status='failed' WHERE id=?").run(document.id);
            let sends=0;await deliverDraftNotifications(f.store,async()=>{sends++;});
            assert.equal(sends,0,change);assert.equal(f.store.forDraft(f.draftId)!.canRetry,false,change);
        }finally{f.close();}
    }
});

test('known paid activity, uncertain execution or corrupt receipt evidence prevents an Unsubmitted-ready email',async()=>{
    for(const kind of ['receipt','bundle_hold','execution','corrupt_receipt']) {
        const f=fixture();
        try {
            f.store.enqueue(f.job,null,environment);
            const evidence=receipt(f),key=bundleExecutionKey('account@example.com',f.job.externalBundleId!);
            if(kind==='receipt' || kind==='corrupt_receipt')f.sql.prepare(`INSERT INTO mifile_receipt_events
                (event_key,filing_job_id,account_identity,observed_at,event_json,external_reference,receipt_kind,remote_status,document_id)
                VALUES ('qa-event',?,'qa-account',?,?,?,'payment','Paid','')`).run(f.job.id,evidence.observedAt,
                    kind==='corrupt_receipt'?'not JSON':JSON.stringify(evidence),evidence.externalReference);
            if(kind==='bundle_hold')f.sql.prepare(`INSERT INTO mifile_bundle_activity
                (execution_key,account_email,bundle_id,observed_at,source_filing_job_id,evidence_json) VALUES (?,?,?,?,?,?)`)
                .run(key,'account@example.com',f.job.externalBundleId,evidence.observedAt,f.job.id,JSON.stringify(evidence));
            if(kind==='execution')f.sql.prepare(`INSERT INTO mifile_submission_intents
                (id,execution_key,filing_job_id,status,snapshot_json,snapshot_digest,created_at,updated_at,actor,attempt_count)
                VALUES ('qa-intent',?,?,'reconciliation_required','{}','qa',?,?,'qa',1)`)
                .run(key,f.job.id,evidence.observedAt,evidence.observedAt);
            let sends=0;await deliverDraftNotifications(f.store,async()=>{sends++;});
            assert.equal(sends,0,kind);assert.equal(f.store.forDraft(f.draftId)!.canRetry,false,kind);
            assert.throws(()=>f.store.retry(f.draftId,true,environment),/MiFILE|evidence/,kind);
        }finally{f.close();}
    }
});

test('an observed Unsubmitted receipt does not block a verified ready notification',async()=>{
    const f=fixture();
    try {
        const evidence=receipt(f,'Unsubmitted');
        f.sql.prepare(`INSERT INTO mifile_receipt_events
            (event_key,filing_job_id,account_identity,observed_at,event_json,external_reference,receipt_kind,remote_status,document_id)
            VALUES ('qa-unsubmitted',?,'qa-account',?,?,?,'bundle_status','Unsubmitted','')`)
            .run(f.job.id,evidence.observedAt,JSON.stringify(evidence),evidence.externalReference);
        assert.equal(f.store.enqueue(f.job,null,environment),true);
        let sends=0;await deliverDraftNotifications(f.store,async()=>{sends++;});
        assert.equal(sends,1);
    }finally{f.close();}
});

test('another job for the same MiFILE bundle cannot duplicate a sent or uncertain ready email',async()=>{
    for(const uncertain of [false,true]) {
        const f=fixture();
        try {
            f.store.enqueue(f.job,null,environment);
            let sends=0;await deliverDraftNotifications(f.store,async()=>{sends++;if(uncertain)throw new Error('Unknown delivery');});
            const next=secondJob(f);
            assert.equal(f.store.enqueue(next,null,environment),false);
            const reopened=new WorkflowDatabase(f.db.getPath());
            try{assert.equal(reopened.draftNotifications().enqueue(next,null,environment),false);}
            finally{reopened.close();}
            await deliverDraftNotifications(f.store,async()=>{sends++;});assert.equal(sends,1);
        }finally{f.close();}
    }
});

test('a newer verification refreshes one still-pending email for the same bundle without losing or duplicating it',async()=>{
    const f=fixture();
    try {
        f.store.enqueue(f.job,null,environment);
        const id=f.sql.prepare('SELECT id FROM draft_notifications').get().id;
        const next=secondJob(f);
        assert.equal(f.store.enqueue(next,'Updated package',environment),true);
        assert.equal(f.sql.prepare('SELECT COUNT(*) AS count FROM draft_notifications').get().count,1);
        assert.equal(f.sql.prepare('SELECT id FROM draft_notifications').get().id,id);
        const jobs:string[]=[];await deliverDraftNotifications(f.store,async mail=>{jobs.push(mail.jobId);assert.match(mail.bodyText,/Updated package/);});
        assert.deepEqual(jobs,[next.id]);
        assert.equal(f.store.enqueue(next,null,environment),false);
    }finally{f.close();}
});

test('stale queued mail cannot starve the next verified package or leave a forever-pending record',async()=>{
    const f=fixture();
    try {
        f.store.enqueue(f.job,null,environment);
        const next=secondJob(f,false);
        assert.equal(f.store.enqueue(next,null,environment),true);
        const jobs:string[]=[];await deliverDraftNotifications(f.store,async mail=>{jobs.push(mail.jobId);});
        assert.deepEqual(jobs,[next.id]);
        assert.equal(f.sql.prepare('SELECT status FROM draft_notifications WHERE filing_job_id=?').get(f.job.id).status,'failed');
        assert.match(f.sql.prepare('SELECT last_error FROM draft_notifications WHERE filing_job_id=?').get(f.job.id).last_error,/newer MiFILE/);
        assert.equal(f.db.getFilingJob(f.job.id)!.status,'prepared');assert.equal(f.db.getFilingJob(next.id)!.status,'prepared');
    }finally{f.close();}
});

test('legacy queued mail requires explicit retry and is regenerated from verified data with current settings',async()=>{
    const f=fixture();
    try {
        f.store.enqueue(f.job,'Example M',environment);
        f.sql.prepare("UPDATE draft_notifications SET payload_json=json_remove(payload_json,'$.readySnapshot')").run();
        let sends=0;await deliverDraftNotifications(f.store,async()=>{sends++;});
        assert.equal(sends,0);assert.equal(f.store.forDraft(f.draftId)!.canRetry,true);
        f.store.retry(f.draftId,true,{...environment,DRAFT_READY_NOTIFY_EMAIL:'new-reviewer@example.com',ADMIN_PUBLIC_URL:'https://new-workflow.example'});
        const mail=f.store.claim()!;
        assert.equal(mail.to,'new-reviewer@example.com');assert.match(mail.bodyText,/https:\/\/new-workflow.example\/\?draft=/);
        assert.match(mail.bodyText,/Email package: Example M/);assert.equal(mail.attempts,1);
    }finally{f.close();}
});
