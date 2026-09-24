import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { WorkflowDatabase } from './database';
import { buildFilingIntake } from './filingIntake';
import { applyLibraryForms, saveFormPdf, readFormPdf, uploadLibraryDocument, FormUploadDependencies } from './formLibrary';
import { recognizeDocumentPdf, recognizeDocumentText, DOCUMENT_LABELS } from './documentRecognition';
import { testPdfFixture } from './testPdfFixture';

function fixture() {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'form-library-'));
    const db = new WorkflowDatabase(path.join(directory, 'workflow.sqlite'));
    const createDraft = (court = 'MI Example County - 25th District Court') => {
        const message = { id: Math.random().toString(), subject: 'NEW LT FILING - Example', receivedDateTime: new Date().toISOString() };
        const email = db.registerEmail(message);
        const id = db.createCaseDraft(email.id, { ...buildFilingIntake(message, []), courtName: court });
        return id;
    };
    const uploads: string[] = [];
    const dependencies: FormUploadDependencies = {
        async upload(_key, filename) {
            uploads.push(filename);
            return { driveId: 'fixture', itemId: filename, fileName: filename, webUrl: `https://onedrive.example/${encodeURIComponent(filename)}` };
        },
    };
    return { db, createDraft, dependencies, uploads, directory, close() { db.close(); fs.rmSync(directory, { recursive: true, force: true }); } };
}

test('PDF titles identify generic filenames; conflicting and unknown files require review', async () => {
    for (const [role, title] of Object.entries(DOCUMENT_LABELS).filter(([role]) => !['unknown', 'ancillary'].includes(role))) {
        const result = await recognizeDocumentPdf(testPdfFixture(title), 'scan001.pdf');
        assert.equal(result.role, role);
        assert.equal(result.source, 'content');
    }
    assert.equal(recognizeDocumentText(['Please refer to the complaint and summons.'], 'scan.pdf').source, 'unknown');
    assert.equal(recognizeDocumentText(['SUMMONS'], 'Complaint.pdf').source, 'conflict');
    assert.equal(recognizeDocumentText(['COMPLAINT', 'SUMMONS'], 'bundle.pdf').source, 'conflict');
    assert.equal(recognizeDocumentText([''], 'Request.pdf').source, 'filename');
    assert.equal(recognizeDocumentText(['LEASE AGREEMENT'], 'attachment.pdf').role, 'ancillary');
});

test('forms persist independently of SQLite, validate PDF titles, and maintain one active version per exact court', async () => {
    const f = fixture();
    try {
        const content = testPdfFixture('Local Rental and Housing Information');
        const input = { role: 'local' as const, courtName: 'MI Example County - 25th District Court', filename: 'Local.pdf', content };
        const first = await saveFormPdf(f.db, input);
        assert.deepEqual(readFormPdf(f.db, first), content);
        assert.equal((await saveFormPdf(f.db, input)).id, first.id);
        const revised = await saveFormPdf(f.db, { ...input, content: testPdfFixture('Local Rental and Housing Information\nRevised') });
        assert.notEqual(first.id, revised.id);
        assert.equal(f.db.listLibraryForms().filter(form => form.active).length, 1);
        assert.deepEqual(readFormPdf(f.db, first), content);
        await assert.rejects(saveFormPdf(f.db, { ...input, role: 'advice' }), /title does not match/);
        await assert.rejects(saveFormPdf(f.db, { ...input, content: Buffer.from('not PDF') }), /PDF/);
        await assert.rejects(saveFormPdf(f.db, { ...input, courtName: '' }), /court/);
        f.db.disableLibraryForm(revised.id);
        assert.equal(f.db.listLibraryForms().filter(form => form.active).length, 0);
        const secondConnection = new WorkflowDatabase(f.db.getPath());
        try { assert.equal(secondConnection.listLibraryForms().length, 2); }
        finally { secondConnection.close(); }
    } finally { f.close(); }
});

test('automatic forms are copied once; attached forms are preserved and court changes block the old Local', async () => {
    const f = fixture();
    try {
        await saveFormPdf(f.db, { role: 'advice', courtName: '', filename: 'Advice.pdf', content: testPdfFixture(DOCUMENT_LABELS.advice) });
        await saveFormPdf(f.db, { role: 'local', courtName: 'MI Example County - 25th District Court', filename: 'Local.pdf', content: testPdfFixture(DOCUMENT_LABELS.local) });
        const id = f.createDraft();
        await applyLibraryForms(f.db, id, f.dependencies);
        await applyLibraryForms(f.db, id, f.dependencies);
        const detail = f.db.getDraftDetail(id)!;
        assert.equal(detail.documents.length, 2);
        assert.equal(f.uploads.length, 2);
        assert.ok(detail.documents.every(doc => doc.oneDriveUrl && doc.formTemplate));
        const changed = f.db.updateCaseDraft(id, { courtName: 'MI Different County - 25th District Court' });
        assert.ok(changed.caseDraft?.validationIssues.some(issue => issue.message.includes('another court')));
        const local = changed.documents.find(doc => doc.formTemplate?.role === 'local')!;
        f.db.removeLibraryDocument(id, local.id);
        assert.equal(f.db.getDraftDetail(id)!.documents.length, 1);
        assert.ok(!f.db.getDraftDetail(id)!.caseDraft?.validationIssues.some(issue => issue.message.includes('another court')));
        const different = f.createDraft('MI Different County - 25th District Court');
        await applyLibraryForms(f.db, different, f.dependencies);
        assert.deepEqual(f.db.getDraftDetail(different)!.documents.map(doc => doc.packageRole), ['advice']);
        const attached = f.createDraft();
        const emailId = f.db.getDraftDetail(attached)!.email.id;
        f.db.addDocument({ emailId, caseDraftId: attached, documentType: DOCUMENT_LABELS.advice,
            originalFilename: 'From attorney.pdf', status: 'uploaded', uploadSource: 'email_intake', oneDriveUrl: 'https://onedrive.example/original' });
        await applyLibraryForms(f.db, attached, f.dependencies);
        assert.equal(f.db.getDraftDetail(attached)!.documents.filter(doc => doc.packageRole === 'advice').length, 1);
        f.db.reviewCaseDraft(attached, 'reject');
        await assert.rejects(applyLibraryForms(f.db, attached, f.dependencies), /locked/);
    } finally { f.close(); }
});

test('a failed form uses existing retries and retains its pinned version even after the library changes', async () => {
    const f = fixture();
    try {
        const old = await saveFormPdf(f.db, { role: 'advice', courtName: '', filename: 'Advice.pdf', content: testPdfFixture(DOCUMENT_LABELS.advice) });
        const id = f.createDraft();
        await applyLibraryForms(f.db, id, { upload: async () => { throw new Error('OneDrive unavailable'); } });
        let document = f.db.getDraftDetail(id)!.documents[0];
        assert.equal(document.status, 'failed');
        assert.ok(document.nextRetryAt);
        assert.match(document.errorMessage!, /OneDrive unavailable/);
        await saveFormPdf(f.db, { role: 'advice', courtName: '', filename: 'Advice revised.pdf', content: testPdfFixture(DOCUMENT_LABELS.advice + '\nRevised') });
        await uploadLibraryDocument(f.db, id, document.id, f.dependencies);
        document = f.db.getDraftDetail(id)!.documents[0];
        assert.equal(document.status, 'uploaded');
        assert.equal(document.formTemplate?.id, old.id);
        await applyLibraryForms(f.db, id, f.dependencies);
        assert.equal(f.db.getDraftDetail(id)!.documents.length, 1);
        const rejected = f.createDraft();
        await applyLibraryForms(f.db, rejected, { upload: async () => { throw new Error('Offline'); } });
        const failed = f.db.getDraftDetail(rejected)!.documents[0];
        f.db.queueDocumentRetry(failed.id);
        f.db.reviewCaseDraft(rejected, 'reject');
        assert.throws(() => f.db.queueDocumentRetry(failed.id), /locked/);
        assert.ok(!f.db.claimDueDocumentRetries(50).some(retry => retry.documentId === failed.id));
    } finally { f.close(); }
});

test('content recognition controls the role and manual confirmation resolves filename conflict', async () => {
    const f = fixture();
    try {
        const id = f.createDraft();
        const emailId = f.db.getDraftDetail(id)!.email.id;
        const doc = f.db.addDocument({ emailId, caseDraftId: id, originalFilename: 'Complaint.pdf', documentType: 'Complaint',
            uploadSource: 'email_intake', status: 'uploaded', oneDriveUrl: 'https://onedrive.example/doc' });
        f.db.recordDocumentRecognition(doc, recognizeDocumentText(['SUMMONS'], 'Complaint.pdf'));
        let detail = f.db.refreshCaseDraftValidation(id);
        assert.equal(detail.documents[0].packageRole, 'summons');
        assert.equal(detail.documents[0].isPrimary, false);
        assert.ok(detail.caseDraft?.validationIssues.some(issue => issue.message.includes('different document types')));
        detail = f.db.updateCaseDraft(id, {}, undefined, undefined, [{ id: doc, filingType: DOCUMENT_LABELS.summons, requiredForFiling: true }]);
        assert.equal(detail.documents[0].filingTypeSource, 'manual');
        assert.ok(!detail.caseDraft?.validationIssues.some(issue => issue.message.includes('different document types')));
    } finally { f.close(); }
});
