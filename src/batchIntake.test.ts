import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { WorkflowDatabase, type CaseSplitInput } from './database';
import { randomUUID } from 'node:crypto';
import { ensureDraftComplaintExtraction } from './draftExtraction';
import { buildFilingIntake, intakeCasePrefix, splitFilingIntake } from './filingIntake';
import { processFilingIntake } from './filingIntakeWorker';
import { downloadIntakeDocuments } from './filingIntakeDownload';
import { emailAttachmentSourceName } from './emailAttachmentSource';
import { testPdfFixture, testTextFieldsFixture } from './testPdfFixture';
import { readSupportingCaseIdentity, matchesSupportingCase } from './batchCaseMatching';
import { saveFormPdf, applyLibraryForms, uploadLibraryDocument } from './formLibrary';
import { CURRENT_COMPLAINT_EXTRACTOR_VERSION, type ComplaintExtractionResult } from './complaintExtractor';
import { parseWorkflowEmail } from './workflowEmail';
import { resolveCourt } from './courtForms';

const message = { id: 'batch-email', subject: 'NEW LT FILING - Several cases',
    from: { emailAddress: { address: 'ajd@devlinlawpllc.com' } }, receivedDateTime: '2026-11-04T09:00:00Z' };
const attachment = (name: string, index: number) => ({ id: 'file-' + index, name, contentType: 'application/pdf', size: 100, isInline: false });
const names = ['Utsey W', 'Walker W'].flatMap(prefix => ['Complaint', 'Summons', 'Request', 'Demand'].map(role => `${prefix} ${role}.pdf`));
const titles: Record<string, string> = { Complaint: 'COMPLAINT NONPAYMENT OF RENT', Summons: 'SUMMONS',
    Request: 'Request for Court Mailing and Record (Landlord-Tenant)', Demand: 'DEMAND FOR POSSESSION' };
const extraction = (defendant: string, courtDistrict: string): ComplaintExtractionResult => ({
    extractorVersion: CURRENT_COMPLAINT_EXTRACTOR_VERSION, formType: 'NONPAYMENT OF RENT', pageCount: 1, textHash: defendant,
    data: { courtDistrict, plaintiff: { displayName: 'Example Property LLC', entityName: 'Example Property LLC' },
        defendants: [{ displayName: defendant, firstName: 'William', lastName: defendant.split(' ')[1],
            address1: '101 Main Street', city: 'Lincoln Park', state: 'MI', postalCode: '48146' }],
        relatedCivilAction: 'none', moneyJudgmentRequested: false, claimAmount: '0.00', mailingRequested: true },
    fieldConfidence: {}, warnings: [],
});

function fixture(input = names) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'batch-intake-'));
    const db = new WorkflowDatabase(path.join(directory, 'workflow.sqlite'));
    const email = db.registerEmail(message);
    const parsed = buildFilingIntake(message, input.map(attachment));
    const packages = db.createCaseDrafts(email.id, parsed);
    const uploads: string[] = [];
    const upload = async (key: string, name: string) => {
        uploads.push(key + '/' + name);
        return { driveId: 'qa', itemId: key + name, fileName: name, webUrl: 'https://onedrive.example/' + key + '/' + encodeURIComponent(name) };
    };
    const dependencies = {
        download: (item: typeof parsed) => downloadIntakeDocuments(item, {
            download: async document => {
                const name = emailAttachmentSourceName(document.downloadUrl)!;
                const role = Object.keys(titles).find(role => name.includes(role))!;
                return Buffer.concat([testPdfFixture(titles[role]), Buffer.from('\n% ' + name)]);
            }, upload, wait: async () => {},
        }),
        extract: async (buffer: Buffer) => extraction(buffer.includes(Buffer.from('Utsey')) ? 'William Utsey' : 'William Walker',
            buffer.includes(Buffer.from('Utsey')) ? '17' : '25'),
        forms: { upload },
    };
    const library = async () => {
        await saveFormPdf(db, { role: 'advice', courtName: '', filename: 'Advice.pdf', content: testPdfFixture('Advice of Rights and Information (Landlord-Tenant)') });
        for (const court of [resolveCourt('17', [])!, resolveCourt('25', [])!]) await saveFormPdf(db,
            { role: 'local', courtName: court, filename: 'Local.pdf', content: testPdfFixture('Local Rental and Housing Information') });
    };
    return { directory, db, email, parsed, packages, uploads, upload, dependencies, library,
        close() { db.close(); fs.rmSync(directory, { recursive: true, force: true }); } };
}

test('case prefixes group every source exactly once, preserve initials, and have stable identities independent of attachment order', () => {
    assert.equal(intakeCasePrefix('Van Dyke J Complaint [$].pdf')?.key, 'van dyke j');
    assert.equal(intakeCasePrefix("O'Neil A Other 02.pdf")?.label, "O'Neil A");
    const files = [...names, 'Utsey A Demand.pdf', 'scan.pdf', 'Utsey W Other 02.pdf'];
    const parsed = buildFilingIntake(message, files.map(attachment));
    const packages = splitFilingIntake(parsed);
    assert.equal(packages.length, 4);
    const sources = packages.flatMap(item => item.filedDocuments.map(doc => doc.downloadUrl));
    assert.equal(sources.length, files.length);
    assert.equal(new Set(sources).size, files.length);
    assert.ok(packages.find(item => item.intake?.packageKey === '__unassigned__')!.intake!.issues.length);
    const reversed = splitFilingIntake(buildFilingIntake(message, files.map(attachment).reverse()));
    assert.deepEqual(packages.map(item => [item.intake?.packageKey, item.intake?.storageKey]), reversed.map(item => [item.intake?.packageKey, item.intake?.storageKey]));
    assert.equal(packages.find(item => item.intake?.packageKey === 'utsey w')!.filedDocuments.length, 5);
});

test('typed Demand identities require exact recipient, Plaintiff and premises and reject conflicting or absent PDF fields', async () => {
    const fields = { 'mailmerge[40]_dc100a_01': 'William Utsey, and all other occupants\r101 Main Street\rLincoln Park, MI 48146',
        'mailmerge[40]_dc100a_02': 'Example Property LLC', 'mailmerge[40]_dc100a_04': '101 Main Street Lincoln Park, MI 48146' };
    const identity = (await readSupportingCaseIdentity(testTextFieldsFixture('DEMAND FOR POSSESSION', fields)))!;
    assert.ok(identity); assert.equal(matchesSupportingCase(identity, extraction('William Utsey', '17').data), true);
    for (const changed of [ { ...identity, recipient: identity.recipient.replace('William', 'Wayne') },
        { ...identity, premises: identity.premises.replace('101', '110') }, { ...identity, plaintiff: 'Other Property LLC' },
        { ...identity, sourceHash: 'old' } ]) assert.equal(matchesSupportingCase(changed, extraction('William Utsey', '17').data), false);
    assert.equal(await readSupportingCaseIdentity(testPdfFixture('DEMAND FOR POSSESSION')), null);
    assert.equal(await readSupportingCaseIdentity(testTextFieldsFixture('DEMAND FOR POSSESSION', { ...fields,
        dc100a_01: 'Wayne Utsey\r101 Main Street\rLincoln Park, MI 48146' })), null);
});

test('a mistyped supporting prefix is corrected only by one exact typed Complaint match; manual changes stop automatic reassignment', async () => {
    const f = fixture([...names, 'Utsey A Demand.pdf']);
    try {
        await f.library();
        const buffer = testTextFieldsFixture('DEMAND FOR POSSESSION', {
            dc100a_01: 'William Utsey, and all other occupants\r101 Main Street\rLincoln Park, MI 48146',
            dc100a_02: 'Example Property LLC', dc100a_04: '101 Main Street Lincoln Park, MI 48146',
        });
        for (const item of f.packages) await processFilingIntake(f.db, f.email.id, item.draftId, item.parsed, {
            ...f.dependencies,
            extract: async content => ({ ...await f.dependencies.extract(content), extractionMethod: 'form_fields',
                fieldConfidence: { plaintiff: 'high', defendants: 'high' } }),
            download: input => input.filedDocuments[0].documentName === 'Utsey A Demand.pdf' ? downloadIntakeDocuments(input,
                { download: async () => buffer, upload: f.upload, wait: async () => {} }) : f.dependencies.download(input),
        });
        const source = f.packages.find(item => item.parsed.intake?.packageKey === 'utsey a')!;
        const target = f.packages.find(item => item.parsed.intake?.packageKey === 'utsey w')!;
        const sql = (f.db as any).db;
        sql.prepare("UPDATE case_drafts SET normalized_data_json=json_set(normalized_data_json,'$.manualDocumentEdits',json('true')) WHERE id=?").run(target.draftId);
        assert.equal(f.db.reconcileBatchSupportingDocuments(f.email.id), 0);
        sql.prepare("UPDATE case_drafts SET normalized_data_json=json_remove(normalized_data_json,'$.manualDocumentEdits') WHERE id=?").run(target.draftId);
        const other = f.packages.find(item => item.parsed.intake?.packageKey === 'walker w')!;
        const otherComplaint = f.db.getDraftDetail(other.draftId)!.documents.find(document => document.isPrimary)!;
        f.db.applyComplaintExtraction(other.draftId, otherComplaint.id, { ...extraction('William Utsey', '17'),
            extractionMethod: 'form_fields', fieldConfidence: { plaintiff: 'high', defendants: 'high' } });
        assert.equal(f.db.reconcileBatchSupportingDocuments(f.email.id), 0, 'Two matching Complaints cannot choose a winner');
        f.db.applyComplaintExtraction(other.draftId, otherComplaint.id, { ...extraction('William Walker', '25'),
            extractionMethod: 'form_fields', fieldConfidence: { plaintiff: 'high', defendants: 'high' } });
        assert.equal(f.db.reconcileBatchSupportingDocuments(f.email.id), 1);
        assert.equal(f.db.reconcileBatchSupportingDocuments(f.email.id), 0);
        assert.equal(f.db.getDraftDetail(source.draftId)!.caseDraft!.status, 'archived');
        f.db.recordIntakeProcessingFailure(source.draftId, new Error('Late background failure'));
        assert.equal(f.db.getDraftDetail(source.draftId)!.caseDraft!.status, 'archived');
        const detail = f.db.getDraftDetail(target.draftId)!;
        assert.equal(detail.documents.length, 7); assert.deepEqual(detail.caseDraft!.validationIssues, []);
        assert.ok(detail.auditLogs.some(log => log.action === 'batch_document_matched_by_pdf_fields'));
        assert.equal(Boolean(JSON.parse(detail.caseDraft!.normalizedDataJson!).manualDocumentEdits), false);
    } finally { f.close(); }
});

test('several cases retain separate PDFs, courts, forms, editable fields, audit trails and filing payloads', async () => {
    const f = fixture();
    try {
        await f.library();
        for (const item of f.packages) await processFilingIntake(f.db, f.email.id, item.draftId, item.parsed, f.dependencies);
        const [utsey, walker] = f.packages;
        const a = f.db.getDraftDetail(utsey.draftId)!, b = f.db.getDraftDetail(walker.draftId)!;
        assert.equal(a.caseDraft!.id, utsey.draftId); assert.equal(b.caseDraft!.id, walker.draftId);
        assert.equal(a.documents.length, 6); assert.equal(b.documents.length, 6);
        assert.equal(a.caseDraft!.filingData.defendants[0].displayName, 'William Utsey');
        assert.equal(b.caseDraft!.filingData.defendants[0].displayName, 'William Walker');
        assert.notEqual(a.caseDraft!.editableData.courtName, b.caseDraft!.editableData.courtName);
        assert.ok(a.documents.every(doc => !doc.originalFilename?.includes('Walker')));
        assert.ok(b.documents.every(doc => !doc.originalFilename?.includes('Utsey')));
        assert.equal(a.documents.find(doc => doc.packageRole === 'ancillary')!.filingRelation, 'connected_to_complaint');
        assert.equal(b.documents.find(doc => doc.packageRole === 'ancillary')!.filingRelation, 'separate');
        assert.deepEqual(a.caseDraft!.validationIssues, []); assert.deepEqual(b.caseDraft!.validationIssues, []);
        const edited = f.db.updateCaseDraft(utsey.draftId, {}, undefined, { ...a.caseDraft!.filingData,
            plaintiff: { ...a.caseDraft!.filingData.plaintiff, phone: '248-555-0101' } });
        assert.equal(edited.caseDraft!.id, utsey.draftId);
        assert.equal(f.db.getDraftDetail(walker.draftId)!.caseDraft!.filingData.plaintiff.phone, '248-703-6201');
        assert.ok(!b.auditLogs.some(log => log.entityType === 'document_record' && a.documents.some(doc => doc.id === log.entityId)));
        assert.deepEqual(new Set(f.db.buildFilingPayload(utsey.draftId).documents.map(doc => doc.id)), new Set(a.documents.map(doc => doc.id)));
        const envelope = f.db.getEmailDetail(f.email.id)!;
        assert.equal(envelope.caseDraft, null); assert.equal(envelope.caseDrafts.length, 2); assert.equal(envelope.documents.length, 12);
        const queue = f.db.listQueue({ scope: 'all' });
        assert.equal(queue.totalItems, 1); assert.equal(queue.items.length, 1); assert.equal(queue.items[0].draftCount, 2);
        assert.equal(queue.items[0].documentCount, 12); assert.equal(queue.items[0].caseDraftId, null);
        assert.equal(f.db.listQueue({ search: 'William Walker' }).totalItems, 1);
        assert.equal(f.db.listDrafts().totalItems, 2);
        const count = f.uploads.length;
        for (const item of f.db.createCaseDrafts(f.email.id, f.parsed)) await processFilingIntake(f.db, f.email.id, item.draftId, item.parsed, f.dependencies);
        assert.equal(f.uploads.length, count);
        assert.equal(f.db.getDraftDetail(utsey.draftId)!.caseDraft!.filingData.plaintiff.phone, '248-555-0101');
        assert.equal(f.db.listDrafts().totalItems, 2);
    } finally { f.close(); }
});

test('a failed sibling attachment does not prevent the other complete case from automatic Unsubmitted queueing', async () => {
    const f = fixture();
    try {
        await f.library();
        f.db.markEmailProcessing(f.email.id);
        for (const item of f.packages) await processFilingIntake(f.db, f.email.id, item.draftId, item.parsed, {
            ...f.dependencies, deferEmailRefresh: true, download: input => input.filedDocuments[0].documentName === 'Utsey W Demand.pdf'
                ? Promise.reject(new Error('Download unavailable')) : f.dependencies.download(input),
        });
        assert.equal(f.db.getEmailDetail(f.email.id)!.email.processingStatus, 'processing');
        f.db.refreshEmailAfterDocumentRetries(f.email.id);
        assert.equal(f.db.getEmailDetail(f.email.id)!.email.processingStatus, 'partial_failure');
        assert.equal(f.db.queueValidatedIntakes(), 1);
        assert.equal(f.db.listFilingJobs()[0].caseDraftId, f.packages[1].draftId);
        assert.equal(f.db.getDraftDetail(f.packages[0].draftId)!.documents.filter(doc => doc.status === 'failed').length, 1);
    } finally { f.close(); }
});

test('replaying a mixed email preserves its saved bundle, manual edits and removed PDFs without uploads or filing jobs', async () => {
    const f = fixture(names.filter(name => name !== 'Walker W Request.pdf'));
    try {
        await f.library();
        for (const item of f.packages) await processFilingIntake(f.db, f.email.id, item.draftId, item.parsed, f.dependencies);
        const [utsey, walker] = f.packages;
        const editable = f.db.getDraftDetail(walker.draftId)!;
        f.db.updateCaseDraft(walker.draftId, {}, 'Keep my review note', {
            ...editable.caseDraft!.filingData,
            plaintiff: { ...editable.caseDraft!.filingData.plaintiff, phone: '(248) 703-6201' },
        });
        const removed = editable.documents.find(document => document.packageRole === 'ancillary')!;
        f.db.removeDraftDocument(walker.draftId, removed.id);
        assert.equal(f.db.queueValidatedIntakes(), 1);
        const job = f.db.claimNextFilingJob()!;
        assert.equal(job.caseDraftId, utsey.draftId);
        f.db.completeFilingJob({ filingJobId: job.id, status: 'prepared', checkpoint: 'saved_unsubmitted',
            externalBundleId: randomUUID(), temporaryCaseNumber: 'TEMP-REPLAY', result: { testSnapshot: true } });
        const beforeSaved = f.db.getDraftDetail(utsey.draftId)!;
        const beforeEditable = f.db.getDraftDetail(walker.draftId)!;
        const beforeJobs = f.db.listFilingJobs();
        const beforeUploads = f.uploads.length;
        for (let replay = 0; replay < 2; replay++) {
            f.db.queueEmailRetry(f.email.id, 'Explicit replay acceptance');
            assert.equal(f.db.shouldSkipEmail(message.id), false);
            f.db.markEmailProcessing(f.email.id);
            for (const item of f.db.createCaseDrafts(f.email.id, f.parsed)) {
                const draft = f.db.getDraftDetail(item.draftId)!.caseDraft!;
                if (!['not_started', 'failed'].includes(draft.filingStatus) || ['rejected', 'archived'].includes(draft.status)) continue;
                item.parsed.intake = JSON.parse(draft.normalizedDataJson!).intake;
                await processFilingIntake(f.db, f.email.id, item.draftId, item.parsed, { ...f.dependencies, deferEmailRefresh: true });
            }
            f.db.reconcileBatchSupportingDocuments(f.email.id);
            f.db.refreshEmailAfterDocumentRetries(f.email.id);
            assert.equal(f.db.queueValidatedIntakes(), 0);
            assert.equal(f.db.shouldSkipEmail(message.id), true);
            assert.equal(f.db.listDrafts().totalItems, 2);
            assert.deepEqual(f.db.listFilingJobs(), beforeJobs);
            assert.equal(f.uploads.length, beforeUploads);
            const saved = f.db.getDraftDetail(utsey.draftId)!;
            assert.deepEqual(saved.caseDraft, beforeSaved.caseDraft);
            assert.deepEqual(saved.documents, beforeSaved.documents);
            const after = f.db.getDraftDetail(walker.draftId)!;
            assert.deepEqual(after.caseDraft!.filingData, beforeEditable.caseDraft!.filingData);
            assert.equal(after.caseDraft!.reviewerNotes, 'Keep my review note');
            for (const field of ['manualFilingPaths', 'manualFilingFields', 'manualEditableFields', 'manualDocumentEdits']) {
                assert.deepEqual(JSON.parse(after.caseDraft!.normalizedDataJson!)[field], JSON.parse(beforeEditable.caseDraft!.normalizedDataJson!)[field]);
            }
            assert.deepEqual(after.documents, beforeEditable.documents);
            assert.ok(!after.documents.some(document => document.id === removed.id));
            assert.ok(after.caseDraft!.validationIssues.some(issue => issue.field === 'package.request'));
        }
        const reopened = new WorkflowDatabase(path.join(f.directory, 'workflow.sqlite'));
        try {
            reopened.queueEmailRetry(f.email.id, 'Replay after reopening the database');
            assert.deepEqual(reopened.createCaseDrafts(f.email.id, f.parsed).map(item => item.draftId), f.packages.map(item => item.draftId));
            assert.deepEqual(reopened.listFilingJobs(), beforeJobs);
            assert.equal(reopened.getDraftDetail(walker.draftId)!.caseDraft!.filingData.plaintiff.phone, '(248) 703-6201');
            assert.deepEqual(reopened.getDraftDetail(utsey.draftId)!.caseDraft, beforeSaved.caseDraft);
        } finally { reopened.close(); }
    } finally { f.close(); }
});

test('email replay still rejects queued, running or uncertain MiFILE work but preserves closed sibling states', () => {
    const f = fixture();
    try {
        const sql = (f.db as any).db, id = f.packages[0].draftId;
        for (const [status, filingStatus] of [
            ['ready_to_file', 'queued'], ['filing_in_progress', 'running'], ['filing_reconciliation', 'reconciliation_required'],
            ['needs_review', 'running'], ['needs_review', 'reconciliation_required'],
        ]) {
            sql.prepare('UPDATE case_drafts SET status=?,filing_status=? WHERE id=?').run(status, filingStatus, id);
            assert.throws(() => f.db.queueEmailRetry(f.email.id), /locked/);
            assert.equal(f.db.getDraftDetail(id)!.caseDraft!.filingStatus, filingStatus);
        }
        for (const [status, filingStatus] of [
            ['filing_prepared', 'prepared'], ['filed_successfully', 'succeeded'], ['archived', 'not_started'], ['rejected', 'not_started'],
        ]) {
            sql.prepare('UPDATE case_drafts SET status=?,filing_status=? WHERE id=?').run(status, filingStatus, id);
            const before = f.db.getDraftDetail(id)!;
            f.db.queueEmailRetry(f.email.id);
            f.db.createCaseDrafts(f.email.id, f.parsed);
            assert.deepEqual(f.db.getDraftDetail(id)!.caseDraft, before.caseDraft);
            assert.deepEqual(f.db.getDraftDetail(id)!.documents, before.documents);
            assert.equal(f.db.listFilingJobs().length, 0);
        }
    } finally { f.close(); }
});

test('an active filing job blocks email replay even if its Draft status is inconsistent', async () => {
    const f = fixture();
    try {
        await f.library();
        for (const item of f.packages) await processFilingIntake(f.db, f.email.id, item.draftId, item.parsed, f.dependencies);
        assert.equal(f.db.queueValidatedIntakes(1), 1);
        const job = f.db.listFilingJobs()[0], sql = (f.db as any).db;
        sql.prepare("UPDATE case_drafts SET status='filing_prepared',filing_status='prepared' WHERE id=?").run(job.caseDraftId);
        assert.throws(() => f.db.queueEmailRetry(f.email.id), /locked/);
        assert.equal(f.db.getFilingJob(job.id)!.status, 'queued');
        assert.equal(f.db.listFilingJobs().length, 1);
    } finally { f.close(); }
});

test('eighteen named cases paginate as drafts while their source email and document totals remain singular', () => {
    const f = fixture(Array.from({ length: 18 }, (_, index) => `Tenant${index} A`).flatMap(prefix =>
        ['Complaint', 'Summons', 'Request', 'Other'].map(role => `${prefix} ${role}.pdf`)));
    try {
        assert.equal(f.packages.length, 18);
        assert.equal(f.db.listDrafts({ pageSize: 10, page: 2 }).items.length, 8);
        const queue = f.db.listQueue({ scope: 'all', pageSize: 10 });
        assert.equal(queue.totalItems, 1); assert.equal(queue.items.length, 1);
        assert.equal(queue.items[0].documentCount, 72);
        assert.ok(f.packages.every(item => f.db.getDraftDetail(item.draftId)!.documents.length === 4));
    } finally { f.close(); }
});

test('duplicate names affect their own case, and legacy single-case records are never silently repartitioned', () => {
    const f = fixture([...names, 'Utsey W Complaint.pdf']);
    try {
        assert.ok(f.packages[0].parsed.intake!.issues.some(issue => issue.includes('Duplicate attachment')));
        assert.equal(f.packages[1].parsed.intake!.issues.length, 0);
        const legacyEmail = f.db.registerEmail({ ...message, id: 'legacy-mixed-email' });
        const legacy = { ...f.parsed, intake: { ...f.parsed.intake!, groups: undefined } };
        const oldId = f.db.createCaseDraft(legacyEmail.id, legacy);
        f.db.updateCaseDraft(oldId, {}, 'Keep my historical notes');
        const result = f.db.createCaseDrafts(legacyEmail.id, f.parsed);
        assert.equal(result.length, 1); assert.equal(result[0].draftId, oldId);
        assert.equal(f.db.getDraftDetail(oldId)!.caseDraft!.reviewerNotes, 'Keep my historical notes');
    } finally { f.close(); }
});

test('misnamed support can move only within its email, preserves source bytes and forces review instead of silently guessing', async () => {
    const f = fixture([...names, 'Utsey A Demand.pdf']);
    try {
        await f.library();
        for (const item of f.packages) await processFilingIntake(f.db, f.email.id, item.draftId, item.parsed, f.dependencies);
        const orphan = f.packages.find(item => item.parsed.intake?.packageKey === 'utsey a')!;
        const target = f.packages.find(item => item.parsed.intake?.packageKey === 'utsey w')!;
        const source = f.db.getDraftDetail(orphan.draftId)!;
        const pdf = source.documents[0];
        assert.throws(() => f.db.moveSupportingDocument(orphan.draftId, pdf.id, target.draftId, 'old-version'), /current supporting PDF/);
        const moved = f.db.moveSupportingDocument(orphan.draftId, pdf.id, target.draftId, pdf.sourceVersion!);
        assert.equal(moved.documents.length, 0); assert.equal(moved.caseDraft!.status, 'archived');
        assert.equal(f.db.getDraftDetail(target.draftId)!.documents.find(doc => doc.id === pdf.id)!.oneDriveUrl, pdf.oneDriveUrl);
        assert.equal(JSON.parse(f.db.getDraftDetail(target.draftId)!.caseDraft!.normalizedDataJson!).manualDocumentEdits, true);
        assert.equal(f.db.createCaseDrafts(f.email.id, f.parsed).find(item => item.draftId === orphan.draftId)!.draftId, orphan.draftId);
        assert.equal(f.db.getDraftDetail(orphan.draftId)!.documents.length, 0);
        const another = f.db.registerEmail({ ...message, id: 'not-this-email' });
        const foreign = f.db.createCaseDraft(another.id, buildFilingIntake(message, []));
        const current = f.db.getDraftDetail(target.draftId)!.documents.find(doc => doc.id === pdf.id)!;
        assert.throws(() => f.db.moveSupportingDocument(target.draftId, pdf.id, foreign, current.sourceVersion!), /same email/);
        const complaint = f.db.getDraftDetail(target.draftId)!.documents.find(doc => doc.isPrimary)!;
        assert.throws(() => f.db.moveSupportingDocument(target.draftId, complaint.id, f.packages[f.packages.length - 1].draftId, complaint.sourceVersion!), /supporting PDF/);
    } finally { f.close(); }
});

test('unassigned PDF issues follow active document ownership and point sibling review to the unresolved group', async () => {
    const f = fixture([...names, 'Demand.pdf', 'Second Demand.pdf']);
    try {
        await f.library();
        for (const item of f.packages) await processFilingIntake(f.db, f.email.id, item.draftId, item.parsed, f.dependencies);
        const orphan = f.packages.find(item => item.parsed.intake?.packageKey === '__unassigned__')!;
        const target = f.packages.find(item => item.parsed.intake?.packageKey === 'utsey w')!;
        const source = f.db.getDraftDetail(orphan.draftId)!;
        const pdf = source.documents.find(document => document.originalFilename === 'Demand.pdf')!;
        assert.ok(source.caseDraft!.validationIssues.some(issue => issue.field === 'document.' + pdf.id && /assign/i.test(issue.message)));
        assert.ok(f.db.getDraftDetail(target.draftId)!.caseDraft!.validationIssues.some(issue =>
            issue.field === 'intake' && issue.relatedDraftId === orphan.draftId));
        const moved = f.db.moveSupportingDocument(orphan.draftId, pdf.id, target.draftId, pdf.sourceVersion!);
        assert.ok(!moved.caseDraft!.validationIssues.some(issue => issue.field === 'document.' + pdf.id ||
            issue.message.includes('Cannot assign Demand.pdf')));
        const remaining = moved.documents.find(document => document.originalFilename === 'Second Demand.pdf')!;
        assert.ok(moved.caseDraft!.validationIssues.some(issue => issue.field === 'document.' + remaining.id));
        const destination = f.db.getDraftDetail(target.draftId)!;
        assert.equal(destination.documents.find(document => document.id === pdf.id)!.oneDriveUrl, pdf.oneDriveUrl);
        assert.equal(destination.documents.find(document => document.id === pdf.id)!.sourceUrl, pdf.sourceUrl);
        f.db.removeDraftDocument(orphan.draftId, remaining.id);
        assert.ok(!f.db.getDraftDetail(orphan.draftId)!.caseDraft!.validationIssues.some(issue => /Cannot assign/.test(issue.message)));
        assert.ok(!f.db.getDraftDetail(target.draftId)!.caseDraft!.validationIssues.some(issue => issue.relatedDraftId === orphan.draftId));
        f.db.createCaseDrafts(f.email.id, f.parsed);
        assert.equal(f.db.getDraftDetail(orphan.draftId)!.documents.length, 0);
    } finally { f.close(); }
});

test('bulk supporting reassignment is atomic, retains source bytes and manual fields, and cannot be replayed', async () => {
    const f = fixture([...names, 'Demand.pdf', 'Second Demand.pdf', 'Third Demand.pdf']);
    try {
        await f.library();
        for (const item of f.packages) await processFilingIntake(f.db, f.email.id, item.draftId, item.parsed, f.dependencies);
        const source=f.packages.find(item=>item.parsed.intake?.packageKey==='__unassigned__')!.draftId;
        const target=f.packages.find(item=>item.parsed.intake?.packageKey==='utsey w')!.draftId;
        const before=f.db.getDraftDetail(source)!,destination=f.db.getDraftDetail(target)!;
        f.db.updateCaseDraft(target,{},undefined,{...destination.caseDraft!.filingData,
            plaintiff:{...destination.caseDraft!.filingData.plaintiff,phone:'248-555-0166'}});
        const selected=before.documents.map(document=>({documentId:document.id,sourceVersion:document.sourceVersion!}));
        for(const bad of [[], [...selected,selected[0]], Array.from({length:101},(_,i)=>({documentId:'document-'+i,sourceVersion:'current'})), [selected[0],{...selected[1],sourceVersion:'stale'}],
            [selected[0],{documentId:destination.documents.find(document=>document.isPrimary)!.id,sourceVersion:'wrong-source'}]]) {
            assert.throws(()=>f.db.moveSupportingDocuments(source,bad,target),/supporting PDF|1-100/);
            assert.deepEqual(f.db.getDraftDetail(source)!.documents.map(document=>document.id),before.documents.map(document=>document.id));
            assert.equal(f.db.getDraftDetail(target)!.documents.length,destination.documents.length);
        }
        const uploads=f.uploads.length;
        const result=f.db.moveSupportingDocuments(source,selected,target);
        assert.equal(result.caseDraft!.status,'archived');assert.equal(result.documents.length,0);
        const after=f.db.getDraftDetail(target)!;
        for(const old of before.documents) {
            const moved=after.documents.find(document=>document.id===old.id)!;
            assert.equal(moved.oneDriveUrl,old.oneDriveUrl);assert.equal(moved.sourceUrl,old.sourceUrl);
            assert.deepEqual(moved.recognition,old.recognition);
        }
        assert.equal(after.caseDraft!.filingData.plaintiff.phone,'248-555-0166');
        assert.equal(after.caseDraft!.reviewedAt,null);
        assert.equal(JSON.parse(after.caseDraft!.normalizedDataJson!).manualDocumentEdits,true);
        assert.equal(after.auditLogs.filter(log=>log.action==='batch_document_moved').length,3);
        assert.throws(()=>f.db.moveSupportingDocuments(source,selected,target),/locked/);
        f.db.createCaseDrafts(f.email.id,f.parsed);
        assert.equal(f.db.getDraftDetail(source)!.documents.length,0);
        assert.equal(f.uploads.length,uploads);assert.equal(f.db.listFilingJobs().length,0);
    } finally { f.close(); }
});

test('bulk reassignment rejects another email or locked package without changing any documents', async () => {
    const f=fixture([...names,'Demand.pdf','Second Demand.pdf']);
    try {
        await f.library();
        for(const item of f.packages)await processFilingIntake(f.db,f.email.id,item.draftId,item.parsed,f.dependencies);
        const source=f.packages.find(item=>item.parsed.intake?.packageKey==='__unassigned__')!.draftId;
        const target=f.packages.find(item=>item.parsed.intake?.packageKey==='utsey w')!.draftId;
        const selected=f.db.getDraftDetail(source)!.documents.map(document=>({documentId:document.id,sourceVersion:document.sourceVersion!}));
        const foreignEmail=f.db.registerEmail({...message,id:'foreign-bulk'});
        const foreign=f.db.createCaseDraft(foreignEmail.id,buildFilingIntake(message,[]));
        assert.throws(()=>f.db.moveSupportingDocuments(source,selected,foreign),/same email/);
        const sql=(f.db as any).db;
        for(const status of ['filing_prepared','filing_reconciliation','filed_successfully','rejected']) {
            sql.prepare('UPDATE case_drafts SET status=? WHERE id=?').run(status,target);
            assert.throws(()=>f.db.moveSupportingDocuments(source,selected,target),/locked/);
            assert.equal(f.db.getDraftDetail(source)!.documents.length,2);
        }
    } finally { f.close(); }
});

test('unassigned groups do not receive standard forms and legacy pinned forms do not prevent source-group archival', async () => {
    const f=fixture([...names,'Complaint.pdf','Demand.pdf']);
    try {
        await f.library();
        for(const item of f.packages)await processFilingIntake(f.db,f.email.id,item.draftId,item.parsed,f.dependencies);
        const source=f.packages.find(item=>item.parsed.intake?.packageKey==='__unassigned__')!.draftId;
        const target=f.packages.find(item=>item.parsed.intake?.packageKey==='utsey w')!.draftId;
        assert.equal(f.db.getDraftDetail(source)!.documents.length,2);
        const count=f.uploads.length;
        await applyLibraryForms(f.db,source,f.dependencies.forms);
        assert.equal(f.uploads.length,count);
        assert.equal(f.db.getDraftDetail(source)!.documents.some(document=>document.formTemplate),false);
        const complaint=f.db.getDraftDetail(source)!.documents.find(document=>document.packageRole==='complaint')!;
        f.db.removeDraftDocument(source,complaint.id);
        const form=f.db.listLibraryForms().find(form=>form.role==='advice')!;
        const legacy=f.db.reserveLibraryDocument(source,form)!;
        await uploadLibraryDocument(f.db,source,legacy,f.dependencies.forms);
        const stored=f.db.getDraftDetail(source)!.documents.find(document=>document.id===legacy)!;
        const pdf=f.db.getDraftDetail(source)!.documents.find(document=>document.packageRole==='ancillary')!;
        const result=f.db.moveSupportingDocuments(source,[{documentId:pdf.id,sourceVersion:pdf.sourceVersion!}],target);
        assert.equal(result.caseDraft!.status,'archived');assert.equal(result.documents.length,1);
        assert.equal(result.documents[0].id,legacy);assert.equal(result.documents[0].oneDriveUrl,stored.oneDriveUrl);
        f.db.createCaseDrafts(f.email.id,f.parsed);
        assert.equal(f.db.getDraftDetail(source)!.documents.length,1);
    } finally { f.close(); }
});

test('a whole case is split atomically, re-read independently and replayed without duplicate drafts or source uploads', async () => {
    const legacy=['LegacyAlpha','LegacyBeta'].flatMap(prefix=>['Complaint','Summons','Request','Demand'].map(role=>prefix+' '+role+'.pdf'));
    const f=fixture([...names,...legacy]);
    try {
        await f.library();
        for(const item of f.packages)await processFilingIntake(f.db,f.email.id,item.draftId,item.parsed,f.dependencies);
        const source=f.packages.find(item=>item.parsed.intake?.packageKey==='__unassigned__')!.draftId;
        f.db.updateCaseDraft(source,{},'Keep source review notes', {...f.db.getDraftDetail(source)!.caseDraft!.filingData,
            plaintiff:{...f.db.getDraftDetail(source)!.caseDraft!.filingData.plaintiff,phone:'248-555-0188'}});
        const before=f.db.getDraftDetail(source)!,uploadCount=f.uploads.length;
        const makeInput=(prefix:string):CaseSplitInput=>{
            const documents=f.db.getDraftDetail(source)!.documents.filter(document=>document.originalFilename!.startsWith(prefix));
            return {requestId:randomUUID(),label:prefix+' case',complaintDocumentId:documents.find(document=>document.packageRole==='complaint')!.id,
                documents:documents.map(document=>({documentId:document.id,sourceVersion:document.sourceVersion!}))};
        };
        const alpha=makeInput('LegacyAlpha'),first=f.db.splitUnassignedCase(source,alpha);
        assert.equal(first.replayed,false);assert.equal(f.db.getDraftDetail(source)!.documents.length,4);
        assert.equal(f.db.findCaseSplit(source,alpha.requestId),first.draftId);
        const created=f.db.getDraftDetail(first.draftId)!;
        assert.equal(created.caseDraft!.primaryDocumentId,alpha.complaintDocumentId);
        assert.equal(created.caseDraft!.complaintReading.status,'queued');
        assert.notEqual(created.caseDraft!.filingData.plaintiff.phone,'248-555-0188');
        assert.equal(created.caseDraft!.complaintExtraction,null);
        assert.equal(JSON.parse(created.caseDraft!.normalizedDataJson!).intake.manual,true);
        for(const document of created.documents){
            const original=before.documents.find(item=>item.id===document.id)!;
            assert.equal(document.oneDriveUrl,original.oneDriveUrl);assert.equal(document.sourceUrl,original.sourceUrl);
            assert.deepEqual(document.recognition,original.recognition);
        }
        assert.deepEqual(f.db.splitUnassignedCase(source,{...alpha,documents:[...alpha.documents].reverse()}),{...first,replayed:true});
        assert.throws(()=>f.db.splitUnassignedCase(source,{...alpha,label:'Changed label'}),/different package/);
        const beta=makeInput('LegacyBeta'),second=f.db.splitUnassignedCase(source,beta);
        assert.equal(f.db.getDraftDetail(source)!.caseDraft!.status,'archived');
        assert.equal(f.db.getDraftDetail(source)!.caseDraft!.reviewerNotes,'Keep source review notes');
        assert.equal(f.db.getDraftDetail(source)!.caseDraft!.filingData.plaintiff.phone,'248-555-0188');
        for(const [result,prefix,defendant,court] of [[first,'LegacyAlpha','Arthur Alpha','17'],[second,'LegacyBeta','Blair Beta','25']] as const){
            const content=Buffer.concat([testPdfFixture(titles.Complaint),Buffer.from('\n% '+prefix+' Complaint.pdf')]);
            await ensureDraftComplaintExtraction(f.db,result.draftId,{content,extract:async()=>extraction(defendant,court)});
            await applyLibraryForms(f.db,result.draftId,f.dependencies.forms);
            const detail=f.db.getDraftDetail(result.draftId)!;
            assert.equal(detail.documents.length,6);assert.deepEqual(detail.caseDraft!.validationIssues,[]);
            assert.equal(detail.caseDraft!.filingData.defendants[0].displayName,defendant);
            assert.equal(detail.documents.find(document=>document.packageRole==='ancillary')!.filingRelation,court==='17'?'connected_to_complaint':'separate');
        }
        assert.equal(f.uploads.length,uploadCount+4,'Only the two new cases\' Advice/Local files are uploaded');
        for(const item of f.db.createCaseDrafts(f.email.id,f.parsed)){
            if(f.db.getDraftDetail(item.draftId)!.caseDraft!.status!=='archived')await processFilingIntake(f.db,f.email.id,item.draftId,item.parsed,f.dependencies);
        }
        assert.equal(f.uploads.length,uploadCount+4);
        assert.equal(f.db.getDraftDetail(source)!.documents.length,0);
        assert.equal(f.db.listDrafts().totalItems,f.packages.length+2);
        f.db.queueValidatedIntakes();
        assert.ok(f.db.listFilingJobs().every(job=>job.caseDraftId!==first.draftId&&job.caseDraftId!==second.draftId),'Manually split cases still need confirmation');
        const reopened=new WorkflowDatabase(path.join(f.directory,'workflow.sqlite'));
        try { assert.equal(reopened.splitUnassignedCase(source,alpha).draftId,first.draftId); }
        finally { reopened.close(); }
    } finally { f.close(); }
});

test('case splitting rejects stale, duplicate, conflicting, foreign or core-incomplete selections without creating a draft', async () => {
    const f=fixture([...names,'LegacyAlpha Complaint.pdf','LegacyAlpha Summons.pdf','LegacyBeta Complaint.pdf']);
    try {
        await f.library();
        for(const item of f.packages)await processFilingIntake(f.db,f.email.id,item.draftId,item.parsed,f.dependencies);
        const source=f.packages.find(item=>item.parsed.intake?.packageKey==='__unassigned__')!.draftId;
        const detail=f.db.getDraftDetail(source)!,complaints=detail.documents.filter(document=>document.packageRole==='complaint');
        const pin=(document:typeof detail.documents[number])=>({documentId:document.id,sourceVersion:document.sourceVersion!});
        const input:CaseSplitInput={requestId:randomUUID(),label:'Case',complaintDocumentId:complaints[0].id,documents:[pin(complaints[0])]};
        const count=f.db.listDrafts().totalItems;
        for(const bad of [{...input,documents:[]},{...input,documents:[pin(complaints[0]),pin(complaints[0])]},
            {...input,documents:complaints.map(pin)},{...input,documents:[{...pin(complaints[0]),sourceVersion:'stale'}]},
            {...input,complaintDocumentId:'not-selected'}, {...input,documents:[{documentId:f.db.getDraftDetail(f.packages.find(item=>item.draftId!==source)!.draftId)!.documents[0].id,sourceVersion:'wrong'}]}]){
            assert.throws(()=>f.db.splitUnassignedCase(source,bad),/Choose|Complaint|source PDF/);
            assert.equal(f.db.listDrafts().totalItems,count);
            assert.equal(f.db.getDraftDetail(source)!.documents.length,detail.documents.length);
        }
        const sql=(f.db as any).db;
        sql.prepare("UPDATE case_drafts SET status='filing_prepared' WHERE id=?").run(source);
        assert.throws(()=>f.db.splitUnassignedCase(source,input),/locked/);
        assert.equal(f.db.listDrafts().totalItems,count);
    } finally { f.close(); }
});

test('named packages from an authorized original email support ordinary subjects but replies and non-system senders cannot replay a thread', async () => {
    const fetch = async () => names.map(attachment);
    const parsed = await parseWorkflowEmail({ ...message, subject: 'Five more', hasAttachments: true }, fetch);
    assert.equal(splitFilingIntake(parsed!).length, 2);
    for (const subject of ['Re: Five more', 'FW: NEW LT FILING - Cases', 'MiFILE - Case Created', 'MiFILE - Document Sent']) {
        assert.equal(await parseWorkflowEmail({ ...message, subject }, fetch), null);
    }
    assert.equal(await parseWorkflowEmail({ ...message, from: { emailAddress: { address: 'client@example.com' } } }, fetch), null);
    assert.equal(await parseWorkflowEmail({ ...message, subject: 'Unrelated' }, async () => [attachment('document.pdf', 1)]), null);
});
