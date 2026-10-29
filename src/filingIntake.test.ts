import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { WorkflowDatabase } from './database';
import { buildFilingIntake, intakeFileName, intakeSenderAllowed, isFilingIntakeSubject } from './filingIntake';
import { emailAttachmentSourceId, emailAttachmentSourceName } from './emailAttachmentSource';
import { downloadIntakeDocuments } from './filingIntakeDownload';
import { processFilingIntake } from './filingIntakeWorker';
import { CURRENT_COMPLAINT_EXTRACTOR_VERSION, extractComplaintPdf, type ComplaintExtractionResult } from './complaintExtractor';
import { testComplaintFormFixture, testPdfFixture } from './testPdfFixture';
import { saveFormPdf } from './formLibrary';

const message = {
    id: 'new-intake-message', internetMessageId: '<new-intake@example.com>',
    subject: 'NEW LT FILING - Example Property v Morgan Tenant',
    from: { emailAddress: { address: 'ajd@devlinlawpllc.com' } },
    receivedDateTime: '2026-09-08T10:00:00Z',
};
const attachment = (name: string, id = name) => ({
    id, name, contentType: 'application/pdf', size: 100, isInline: false,
});
const pdf = testPdfFixture();
const extraction: ComplaintExtractionResult = {
    extractorVersion: CURRENT_COMPLAINT_EXTRACTOR_VERSION, formType: 'NONPAYMENT OF RENT', pageCount: 1, textHash: 'fixture',
    data: {
        courtDistrict: '25',
        plaintiff: { displayName: 'Example Property LLC', entityName: 'Example Property LLC',
            address1: '201 Main Street', city: 'Lincoln Park', state: 'MI', postalCode: '48146' },
        defendants: [{ displayName: 'Morgan Tenant', firstName: 'Morgan', lastName: 'Tenant',
            address1: '101 Main Street', city: 'Lincoln Park', state: 'MI', postalCode: '48146' }],
        relatedCivilAction: 'none', moneyJudgmentRequested: false, claimAmount: '0.00', mailingRequested: true,
    }, fieldConfidence: {}, warnings: [],
};

function fixture(names: string[], packageMode?: 'standard_lt' | 'custom') {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'filing-intake-'));
    const db = new WorkflowDatabase(path.join(directory, 'test.sqlite'));
    const email = db.registerEmail(message);
    const parsed = buildFilingIntake(message, names.map(name => attachment(name)));
    if (packageMode) {
        parsed.intake!.manual = true;
        parsed.intake!.packageMode = packageMode;
        parsed.intake!.issues = [];
    }
    const draftId = db.createCaseDraft(email.id, parsed);
    const uploaded: string[] = [];
    const dependencies = {
        download: (input: typeof parsed) => downloadIntakeDocuments(input, {
            download: async () => pdf,
            upload: async (_key: string, name: string) => {
                uploaded.push(name);
                return { driveId: 'drive', itemId: name, fileName: name, webUrl: `https://onedrive.example/${encodeURIComponent(name)}` };
            },
            wait: async () => {},
        }),
        extract: async () => extraction,
    };
    return { db, email, parsed, draftId, uploaded, dependencies, close: () => {
        db.close(); fs.rmSync(directory, { recursive: true, force: true });
    } };
}

test('intake uses an explicit subject and authorized sender; replies and court notifications are excluded', () => {
    assert.equal(isFilingIntakeSubject(message.subject), true);
    assert.equal(isFilingIntakeSubject('new lt filing'), true);
    for (const subject of ['Re: NEW LT FILING - Test', 'FW: NEW LT FILING', 'NEW LT FILINGS', 'MiFILE - Document Filed']) {
        assert.equal(isFilingIntakeSubject(subject), false);
    }
    assert.equal(intakeSenderAllowed(message, {}), true);
    assert.equal(intakeSenderAllowed({ from: { emailAddress: { address: 'unknown@example.com' } } }, {}), false);
    assert.equal(intakeSenderAllowed(message, { FILING_INTAKE_ALLOWED_SENDERS: 'somebody@example.com' }), false);
});

test('required Complaint answers and Other/Connected choices cannot be waived by confirming a package', () => {
    const f = fixture([]);
    try {
        const ids = ['Complaint', 'Advice', 'Local', 'Summons', 'Request', 'Demand'].map(role => f.db.addDocument({
            emailId:f.email.id,caseDraftId:f.draftId,currentFilename:role+'.pdf',documentType:role,
            oneDriveUrl:'https://onedrive.example/'+role,mimeType:'application/pdf',uploadSource:'test',status:'uploaded',
        }));
        f.db.applyComplaintExtraction(f.draftId,ids[0],extraction);
        f.db.updateCaseDraft(f.draftId,{courtName:'25th District Court'},undefined,undefined,
            [{id:ids[5],filingRelation:'separate',filingType:'Other'}]);
        const initial=f.db.refreshCaseDraftValidation(f.draftId).caseDraft!;
        assert.deepEqual(initial.validationIssues,[]);
        const cases = [
            {patch:{relatedCivilAction:'unknown'},field:'filingData.relatedCivilAction'},
            {patch:{moneyJudgmentRequested:null},field:'filingData.moneyJudgmentRequested'},
            {patch:{moneyJudgmentRequested:true,claimAmount:null},field:'filingData.claimAmount'},
            {patch:{relatedCivilAction:'previously_filed',relatedCaseCourt:null,relatedCaseDocketNumber:null,relatedCasePending:null},field:'filingData.relatedCaseCourt'},
            {patch:{plaintiff:{...initial.filingData.plaintiff,address1:null}},field:'filingData.plaintiff.address1'},
        ];
        for(const {patch,field} of cases){
            const updated=f.db.updateCaseDraft(f.draftId,{},undefined,{...initial.filingData,...patch});
            assert.ok(updated.caseDraft!.validationIssues.some(issue=>issue.field===field && issue.severity==='error'),field);
            assert.throws(()=>f.db.reviewCaseDraft(f.draftId,'approve'),/Cannot approve draft/);
            assert.throws(()=>f.db.buildFilingPayload(f.draftId),/Filing is blocked/);
            assert.equal(f.db.queueValidatedIntakes(),0);
        }
        const relationship=f.db.updateCaseDraft(f.draftId,{},undefined,initial.filingData,
            [{id:ids[5],filingRelation:'unknown',filingType:'Other'}]);
        assert.ok(relationship.caseDraft!.validationIssues.some(issue=>issue.field==='document.'+ids[5] && issue.severity==='error'));
        assert.throws(()=>f.db.reviewCaseDraft(f.draftId,'approve'),/Choose whether/);
    }finally{f.close();}
});

test('attachment identity distinguishes duplicate names and keeps encoded punctuation intact', () => {
    const parsed = buildFilingIntake(message, [attachment('Complaint ?1.pdf', 'a/+=1'), attachment('Complaint ?1.pdf', 'b/+=2')]);
    assert.equal(parsed.isMiFile, false);
    assert.equal(parsed.intake?.issues.length, 1);
    const [first, second] = parsed.filedDocuments;
    assert.notEqual(first.downloadUrl, second.downloadUrl);
    assert.equal(emailAttachmentSourceId(first.downloadUrl), 'a/+=1');
    assert.equal(emailAttachmentSourceName(first.downloadUrl), 'Complaint ?1.pdf');
    assert.notEqual(intakeFileName(first.documentName!, first.downloadUrl!), intakeFileName(second.documentName!, second.downloadUrl!));
});

test('unsupported attachments remain visible as review issues; inline images are ignored', () => {
    const parsed = buildFilingIntake(message, [
        { ...attachment('case.zip'), contentType: 'application/zip' },
        { ...attachment('logo.png'), contentType: 'image/png', isInline: true },
    ]);
    assert.equal(parsed.filedDocuments.length, 0);
    assert.equal(parsed.intake?.issues.length, 2);
    assert.match(parsed.intake!.issues[0], /case.zip/);
});

test('upload retry uses the same file identity after an uncertain upload and does not redownload the PDF', async () => {
    const parsed = buildFilingIntake(message, [attachment('Complaint.pdf')]);
    const names: string[] = [];
    let downloads = 0;
    const result = await downloadIntakeDocuments(parsed, {
        download: async () => { downloads++; return pdf; },
        upload: async (_key, name) => {
            names.push(name);
            if (names.length === 1) throw new Error('Connection lost after upload');
            return { driveId: 'd', itemId: 'i', fileName: name, webUrl: 'https://onedrive.example/file' };
        }, wait: async () => {},
    });
    assert.equal(downloads, 1);
    assert.equal(names[0], names[1]);
    assert.equal(result.downloaded.length, 1);
    assert.equal(result.failures.length, 0);
});

test('invalid PDFs are not uploaded and include the validation error for the admin', async () => {
    const result = await downloadIntakeDocuments(buildFilingIntake(message, [attachment('Complaint.pdf')]), {
        download: async () => Buffer.from('<html>Login required</html>'),
        upload: async () => { throw new Error('Must not upload'); }, wait: async () => {},
    });
    assert.equal(result.notificationFiles.length, 0);
    assert.match(result.failures[0].reason, /HTML/);
    assert.equal(result.failures[0].attemptLog?.[0].stage, 'validation');
});

test('intake creates one Draft, extracts the Complaint, and reprocessing does not duplicate uploaded documents', async () => {
    const f = fixture(['Complaint.pdf', 'Advice.pdf', 'Local.pdf', 'Summons.pdf', 'Request.pdf', 'Other.pdf']);
    try {
        const first = await processFilingIntake(f.db, f.email.id, f.draftId, f.parsed, f.dependencies);
        assert.equal(first.documents.length, 6);
        assert.ok(first.documents.every(document => document.status === 'uploaded'));
        assert.equal(first.caseDraft?.filingEligible, true);
        assert.equal(first.caseDraft?.filingData.plaintiff.displayName, 'Example Property LLC');
        assert.equal(first.documents.find(document => document.packageRole === 'complaint')?.filingType, 'Complaint for Possession Only');
        assert.equal(f.db.createCaseDraft(f.email.id, f.parsed), f.draftId);
        await processFilingIntake(f.db, f.email.id, f.draftId, f.parsed, f.dependencies);
        assert.equal(f.uploaded.length, 6);
        assert.equal(f.db.getDraftDetail(f.draftId)?.documents.length, 6);
    } finally { f.close(); }
});

test('a failed attachment does not block the remaining package and can be retried independently', async () => {
    const f = fixture(['Complaint.pdf', 'Advice.pdf', 'Summons.pdf']);
    try {
        const detail = await processFilingIntake(f.db, f.email.id, f.draftId, f.parsed, {
            ...f.dependencies,
            download: async input => {
                if (input.filedDocuments[0].documentName === 'Advice.pdf') throw new Error('Graph unavailable');
                return f.dependencies.download(input);
            },
        });
        assert.equal(detail.documents.filter(document => document.status === 'uploaded').length, 2);
        const failed = detail.documents.find(document => document.status === 'failed')!;
        assert.match(failed.errorMessage!, /Graph unavailable/);
        assert.ok(failed.nextRetryAt);
        assert.equal(detail.caseDraft?.status, 'needs_review');
        await processFilingIntake(f.db, f.email.id, f.draftId, f.parsed, f.dependencies);
        assert.equal(f.uploaded.length, 3);
        const recovered = f.db.getDraftDetail(f.draftId)!;
        assert.equal(recovered.documents.length, 3);
        assert.notEqual(recovered.caseDraft?.status, 'ready_to_file', 'missing required documents must still block filing');
    } finally { f.close(); }
});

test('Complaint extraction failure is visible and does not turn a successfully uploaded file into a download failure', async () => {
    const f = fixture(['Complaint.pdf', 'Advice.pdf']);
    try {
        const detail = await processFilingIntake(f.db, f.email.id, f.draftId, f.parsed, {
            ...f.dependencies, extract: async () => { throw new Error('Password-protected PDF'); },
        });
        assert.ok(detail.documents.every(document => document.status === 'uploaded'));
        assert.ok(detail.caseDraft?.validationIssues.some(issue => issue.message.includes('Password-protected')));
        const complaint = detail.documents.find(document => document.packageRole === 'complaint')!;
        f.db.applyComplaintExtraction(f.draftId, complaint.id, extraction);
        assert.ok(!f.db.getDraftDetail(f.draftId)?.caseDraft?.validationIssues.some(issue => issue.message.includes('Password-protected')));
    } finally { f.close(); }
});

test('queued intake emails are recovered even after they leave the most recent inbox page', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'intake-backlog-'));
    const db = new WorkflowDatabase(path.join(directory, 'test.sqlite'));
    try {
        db.registerEmail(message);
        assert.equal(db.listPendingEmails()[0]?.externalMessageId, message.id);
    } finally { db.close(); fs.rmSync(directory, { recursive: true, force: true }); }
});

test('attachment discovery failures back off and remain manually retryable before a Draft exists', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'intake-discovery-'));
    const db = new WorkflowDatabase(path.join(directory, 'test.sqlite'));
    try {
        const email = db.registerEmail(message);
        db.markEmailProcessing(email.id);
        db.scheduleEmailDiscoveryRetry(email.id, new Error('Graph response was truncated'));
        const detail = db.getEmailDetail(email.id)!;
        assert.equal(detail.email.processingStatus, 'failed');
        assert.match(detail.email.processingError!, /Graph response/);
        assert.ok(detail.email.nextRetryAt);
        assert.equal(db.shouldSkipEmail(message.id), true);
        assert.equal(db.listPendingEmails().length, 0);
        db.queueEmailRetry(email.id);
        assert.equal(db.shouldSkipEmail(message.id), false);
        assert.equal(db.listPendingEmails().length, 1);
        assert.equal(db.getEmailDetail(email.id)!.email.nextRetryAt, null);
    } finally { db.close(); fs.rmSync(directory, { recursive: true, force: true }); }
});

test('a validated intake queues only preparation, locks account changes, and cannot be queued twice', async () => {
    const f = fixture(['Complaint.pdf', 'Advice.pdf', 'Local.pdf', 'Summons.pdf', 'Request.pdf', 'Other.pdf']);
    try {
        await processFilingIntake(f.db, f.email.id, f.draftId, f.parsed, f.dependencies);
        const detail = f.db.updateCaseDraft(f.draftId, { courtName: '25th District Court' });
        assert.equal(detail.caseDraft?.filingData.caseType, 'LT - Landlord-Tenant Summary Proceedings');
        assert.throws(() => f.db.reviewCaseDraft(f.draftId, 'approve'), /filename only/);
        f.db.updateCaseDraft(f.draftId, {}, undefined, undefined, detail.documents.map(doc => ({
            id: doc.id, filingType: doc.filingType, filingName: doc.currentFilename,
            filingRelation: 'separate', filingRelationReviewed: true, requiredForFiling: true,
        })));
        f.db.reviewCaseDraft(f.draftId, 'approve');
        assert.throws(() => f.db.queueFilingJob(f.draftId, 'submit' as any), /Final court submission is disabled/);
        const job = f.db.queueFilingJob(f.draftId);
        assert.equal(job.mode, 'prepare');
        assert.equal(job.payload?.documents.length, 6);
        assert.equal(job.payload?.filingData.claimAmount, '0.00');
        assert.equal(job.payload?.documents[0].packageRole, 'complaint');
        assert.throws(() => f.db.queueFilingJob(f.draftId), /active MiFILE job/);
        assert.throws(() => f.db.saveMiFileAccountSetting('not-used'), /Wait for queued/);
        assert.throws(() => f.db.updateCaseDraft(f.draftId, { courtName: 'Another court' }), /locked/);
        assert.throws(() => f.db.applyComplaintExtraction(f.draftId, job.payload!.documents[0].id, extraction), /locked/);
        assert.throws(() => f.db.reviewCaseDraft(f.draftId, 'reject'), /Resolve or complete/);
        assert.equal(f.db.claimNextFilingJob()?.id, job.id);
        assert.throws(() => f.db.queueEmailRetry(f.email.id), /locked/);
    } finally { f.close(); }
});

test('automatic preparation only queues complete new intakes once and never skips warnings', async () => {
    const f = fixture(['Complaint.pdf', 'Advice.pdf', 'Local.pdf', 'Summons.pdf', 'Request.pdf', 'Other.pdf']);
    try {
        await processFilingIntake(f.db, f.email.id, f.draftId, f.parsed, f.dependencies);
        assert.equal(f.db.queueValidatedIntakes(), 0);
        const detail = f.db.updateCaseDraft(f.draftId, {courtName:'25th District Court'});
        f.db.updateCaseDraft(f.draftId, {}, undefined, undefined, detail.documents.map(doc => ({
            id:doc.id, filingType:doc.filingType, filingName:doc.currentFilename,
            filingRelation:'separate', filingRelationReviewed:true, requiredForFiling:true,
        })));
        f.db.refreshCaseDraftValidation(f.draftId);
        assert.equal(f.db.queueValidatedIntakes(), 1);
        assert.equal(f.db.queueValidatedIntakes(), 0);
        const job = f.db.claimNextFilingJob();
        assert.equal(job?.mode, 'prepare');
        assert.equal(job?.triggerSource, 'validated_intake');
    } finally { f.close(); }
});

test('email pipeline reads PDF fields, inserts library forms, connects both supporting PDFs, and queues only the complete intake', async () => {
    const names = ['Complaint.pdf', 'Summons.pdf', 'Request.pdf', 'Demand.pdf', 'Lease.pdf'];
    const f = fixture(names.filter(name => name !== 'Request.pdf'));
    const court = 'MI Oakland County - Oak Park - 45th District Court';
    const content = new Map([
        ['Complaint.pdf', testComplaintFormFixture({ 1: '45th', 5: 'QA Pipeline Property LLC',
            6: 'Adam J Devlin P72877\r30850 Telegraph Rd Ste 250\rBingham Farms, MI 48025\r248 703 6201',
            7: 'Jamie Pipeline, and all other occupants\r101 Rental Street\rOak Park, MI 48237' })],
        ['Summons.pdf', testPdfFixture('Summons, Landlord-Tenant/Land Contract')],
        ['Request.pdf', testPdfFixture('Request for Court Mailing and Record (Landlord-Tenant)')],
        ['Demand.pdf', testPdfFixture('DEMAND FOR POSSESSION')],
        ['Lease.pdf', testPdfFixture('RESIDENTIAL LEASE AGREEMENT')],
    ]);
    const uploads: string[] = [];
    const upload = async (_key: string, filename: string) => {
        uploads.push(filename);
        return { fileName: filename, driveId: 'fixture', itemId: filename,
            webUrl: `https://onedrive.example/${encodeURIComponent(filename)}` };
    };
    const dependencies = {
        download: (input: typeof f.parsed) => downloadIntakeDocuments(input, {
            download: async source => {
                const buffer = content.get(emailAttachmentSourceName(source.downloadUrl)!);
                assert.ok(buffer, 'expected attachment source');
                return buffer;
            }, upload, wait: async () => {},
        }),
        extract: extractComplaintPdf,
        forms: { upload },
    };
    try {
        await saveFormPdf(f.db, { role: 'advice', courtName: '', filename: 'Advice.pdf',
            content: testPdfFixture('Advice of Rights and Information (Landlord-Tenant)') });
        await saveFormPdf(f.db, { role: 'local', courtName: court, filename: '45 Local.pdf',
            content: testPdfFixture('Local Rental and Housing Information') });
        const incomplete = await processFilingIntake(f.db, f.email.id, f.draftId, f.parsed, dependencies);
        assert.equal(incomplete.documents.length, 6);
        assert.ok(incomplete.caseDraft?.validationIssues.some(issue => /missing Request/.test(issue.message)));
        assert.equal(f.db.queueValidatedIntakes(), 0);

        const completeMessage = { ...message, id: 'complete-pipeline', internetMessageId: '<complete-pipeline@example.com>' };
        const email = f.db.registerEmail(completeMessage);
        const parsed = buildFilingIntake(completeMessage, names.map(name => attachment(name)));
        const draftId = f.db.createCaseDraft(email.id, parsed);
        const complete = await processFilingIntake(f.db, email.id, draftId, parsed, dependencies);
        assert.equal(complete.caseDraft?.editableData.courtName, court);
        assert.equal(complete.caseDraft?.filingData.plaintiff.displayName, 'QA Pipeline Property LLC');
        assert.equal(complete.caseDraft?.filingData.defendants[0].displayName, 'Jamie Pipeline');
        assert.equal(complete.caseDraft?.filingData.claimAmount, '1991.50');
        assert.deepEqual(complete.caseDraft?.validationIssues, []);
        assert.equal(complete.documents.length, 7);
        assert.ok(complete.documents.every(document => document.status === 'uploaded'));
        assert.equal(complete.documents.filter(document => document.formTemplate).length, 2);
        const uploadCount = uploads.length;
        await processFilingIntake(f.db, email.id, draftId, parsed, dependencies);
        assert.equal(uploads.length, uploadCount, 'reprocessing must not duplicate uploads or forms');
        assert.equal(f.db.queueValidatedIntakes(), 1);
        assert.equal(f.db.queueValidatedIntakes(), 0);
        const job = f.db.claimNextFilingJob()!;
        assert.equal(job.caseDraftId, draftId);
        assert.equal(job.mode, 'prepare');
        assert.equal(job.triggerSource, 'validated_intake');
        assert.equal(job.payload?.documents.length, 7);
        const complaint = job.payload!.documents.find(document => document.packageRole === 'complaint')!;
        const connected = job.payload!.documents.filter(document => document.packageRole === 'ancillary');
        assert.equal(connected.length, 2);
        assert.equal(complaint.isPrimary, true);
        assert.ok(connected.every(document => document.filingRelation === 'connected_to_complaint'));
        assert.equal(f.db.getDraftDetail(f.draftId)?.caseDraft?.filingStatus, 'not_started');
    } finally { f.close(); }
});

test('standard LT uploads cannot waive required documents and still require explicit preparation', () => {
    const f = fixture([], 'standard_lt');
    try {
        const ids = ['Complaint', 'Advice', 'Local', 'Summons', 'Demand'].map(role => f.db.addDocument({
            emailId:f.email.id,caseDraftId:f.draftId,currentFilename:role+'.pdf',documentType:role,
            oneDriveUrl:'https://onedrive.example/'+role,mimeType:'application/pdf',uploadSource:'admin_draft_upload',status:'uploaded',
        }));
        f.db.applyComplaintExtraction(f.draftId, ids[0], extraction);
        const incomplete = f.db.updateCaseDraft(f.draftId, {courtName:'25th District Court'}, undefined,
            undefined, [{id:ids[4],filingRelation:'separate',filingType:'Other'}]);
        assert.equal(incomplete.caseDraft!.manualPackage, false);
        assert.ok(incomplete.caseDraft!.validationIssues.some(issue => issue.field === 'package.request'));
        assert.throws(() => f.db.reviewCaseDraft(f.draftId, 'approve'), /Request/);
        assert.throws(() => f.db.buildFilingPayload(f.draftId), /Request/);
        const requestId = f.db.addDocument({emailId:f.email.id,caseDraftId:f.draftId,
            currentFilename:'Request.pdf',documentType:'Request',oneDriveUrl:'https://onedrive.example/request',
            mimeType:'application/pdf',uploadSource:'admin_draft_upload',status:'uploaded'});
        const complete = f.db.updateCaseDraft(f.draftId, {}, undefined, undefined,
            [{id:requestId,filingRelation:'connected_to_complaint',requiredForFiling:false}]);
        const request = complete.documents.find(document => document.id === requestId)!;
        assert.equal(request.requiredForFiling, true);
        assert.equal(request.filingRelation, 'separate');
        assert.deepEqual(complete.caseDraft!.validationIssues, []);
        assert.equal(f.db.queueValidatedIntakes(), 0, 'uploaded packages wait for explicit confirmation');
        f.db.reviewCaseDraft(f.draftId, 'approve');
        const job = f.db.queueFilingJob(f.draftId);
        assert.equal(job.payload!.documents.length, 6);
    } finally { f.close(); }
});

for (const packageMode of [undefined, 'custom'] as const) {
test(`${packageMode || 'legacy manual'} Drafts can prepare a reviewed arbitrary PDF package without a Complaint`, () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'manual-filing-'));
    const db = new WorkflowDatabase(path.join(directory, 'test.sqlite'));
    try {
        const manualMessage = {
            id: 'manual-intake-test',
            internetMessageId: '<manual-intake-test@example.com>',
            subject: 'New case - manual upload',
            receivedDateTime: '2026-09-28T12:00:00Z',
        };
        const email = db.registerEmail(manualMessage);
        const parsed = buildFilingIntake(manualMessage, []);
        parsed.intake!.manual = true;
        parsed.intake!.packageMode = packageMode;
        parsed.intake!.issues = [];
        const draftId = db.createCaseDraft(email.id, parsed);
        const documentId = db.addDocument({
            emailId: email.id,
            caseDraftId: draftId,
            originalFilename: 'Reviewed supporting document.pdf',
            currentFilename: 'Reviewed-supporting-document.pdf',
            oneDriveUrl: 'https://onedrive.example/reviewed-document',
            documentType: 'Unclassified document',
            mimeType: 'application/pdf',
            uploadSource: 'admin_draft_upload',
            status: 'uploaded',
        });
        const filingData = {
            ...db.getDraftDetail(draftId)!.caseDraft!.filingData,
            relatedCivilAction: 'none' as const,
            moneyJudgmentRequested: false,
            claimAmount: '0.00',
            plaintiff: {
                id: 'plaintiff-1', partyType: 'entity' as const,
                displayName: 'Example Property LLC', entityName: 'Example Property LLC',
                firstName: null, middleName: null, lastName: null, suffix: null,
                address1: '200 Main Street', address2: null, city: 'Lincoln Park',
                state: 'MI', postalCode: '48146', phone: null, email: null,
            },
            defendants: [{
                id: 'defendant-1', partyType: 'person' as const,
                displayName: 'Taylor Tenant', entityName: null, firstName: 'Taylor',
                middleName: null, lastName: 'Tenant', suffix: null,
                address1: '100 Main Street', address2: null, city: 'Lincoln Park',
                state: 'MI', postalCode: '48146', phone: null, email: null,
            }],
            attorney: {
                name: 'Adam J Devlin', barNumber: 'P72877',
                address1: '30850 Telegraph Rd', address2: 'Suite 250',
                city: 'Bingham Farms', state: 'MI', postalCode: '48025',
                phone: '2487036201', email: 'ajd@devlinlawpllc.com',
            },
        };
        const ready = db.updateCaseDraft(
            draftId,
            { courtName: '25th District Court' },
            undefined,
            filingData,
            [{
                id: documentId,
                filingName: 'Reviewed supporting document',
                filingType: 'Other',
                filingRelation: 'separate',
                requiredForFiling: true,
            }],
        );
        assert.equal(ready.caseDraft?.manualPackage, true);
        assert.ok(!ready.caseDraft?.validationIssues.some(issue =>
            /Complaint|standard nonpayment package/.test(issue.message)));
        assert.ok(!ready.caseDraft?.validationIssues.some(issue => issue.severity === 'error'),
            JSON.stringify(ready.caseDraft?.validationIssues));
        db.reviewCaseDraft(draftId, 'approve');
        const job = db.queueFilingJob(draftId);
        assert.equal(job.payload?.documents.length, 1);
        assert.equal(job.payload?.documents[0].filingType, 'Other');
        assert.equal(job.payload?.documents[0].isPrimary, false);
        assert.equal(db.queueValidatedIntakes(), 0, 'manual packages require an explicit click');
    } finally {
        db.close();
        fs.rmSync(directory, { recursive: true, force: true });
    }
});
}
