import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { WorkflowDatabase } from './database';
import { buildFilingIntake, intakeCasePrefix, splitFilingIntake } from './filingIntake';
import { processFilingIntake } from './filingIntakeWorker';
import { downloadIntakeDocuments } from './filingIntakeDownload';
import { emailAttachmentSourceName } from './emailAttachmentSource';
import { testPdfFixture, testTextFieldsFixture } from './testPdfFixture';
import { readSupportingCaseIdentity, matchesSupportingCase } from './batchCaseMatching';
import { saveFormPdf } from './formLibrary';
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
