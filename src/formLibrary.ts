import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import type { WorkflowDatabase } from './database';
import { FormRole, LibraryForm, courtKey } from './formLibraryTypes';
import { inspectFilingPdf } from './pdfValidation';
import { recognizeDocumentText } from './documentRecognition';
import { INTAKE_MAX_PDF_BYTES, intakeFileName } from './filingIntake';

function formPath(db: WorkflowDatabase, sha: string): string {
    if (!/^[a-f0-9]{64}$/.test(sha)) throw new Error('Invalid form identity');
    return path.join(path.dirname(db.getPath()), 'filing-forms', sha + '.pdf');
}

export async function saveFormPdf(db: WorkflowDatabase, input: { role: FormRole; courtName: string; filename: string; content: Buffer }) {
    if (!['advice', 'local'].includes(input.role)) throw new Error('Choose Advice or Local');
    if (input.role === 'local' && !input.courtName.trim()) throw new Error('Enter the exact MiFILE court name');
    if (!input.content.length || input.content.length > INTAKE_MAX_PDF_BYTES) throw new Error('The PDF must be within 25 MB');
    const pages = await inspectFilingPdf(input.content);
    const recognition = recognizeDocumentText(pages, '');
    if (recognition.source === 'conflict' || (recognition.source === 'content' && recognition.role !== input.role)) {
        throw new Error('The PDF title does not match the selected form type');
    }
    const sha256 = createHash('sha256').update(input.content).digest('hex');
    const filename = formPath(db, sha256);
    fs.mkdirSync(path.dirname(filename), { recursive: true });
    // Immutable content-addressed files keep pending Drafts pinned to their original version.
    if (!fs.existsSync(filename)) fs.writeFileSync(filename, input.content, { flag: 'wx' });
    return db.saveLibraryForm({ role: input.role, courtName: input.courtName,
        filename: path.basename(input.filename).slice(0, 250) || `${input.role}.pdf`, sha256, fileSize: input.content.length });
}

export function readFormPdf(db: WorkflowDatabase, form: LibraryForm): Buffer {
    const buffer = fs.readFileSync(formPath(db, form.sha256));
    if (createHash('sha256').update(buffer).digest('hex') !== form.sha256) throw new Error('The stored form failed its integrity check');
    return buffer;
}

export interface FormUploadDependencies {
    upload(storageKey: string, filename: string, buffer: Buffer): Promise<{ fileName: string; webUrl: string; driveId: string; itemId: string }>;
}

const productionUpload: FormUploadDependencies = {
    async upload(storageKey, filename, buffer) {
        const { ensureIntakeFolder, uploadFileBufferToFolder, createFileLink } = await import('./oneDriveClient');
        const folder = await ensureIntakeFolder(storageKey);
        const file = await uploadFileBufferToFolder(folder.driveId, folder.itemId, filename, buffer);
        return { ...file, webUrl: await createFileLink(file.driveId, file.itemId) };
    },
};

export async function uploadLibraryDocument(db: WorkflowDatabase, draftId: string, documentId: string, dependencies = productionUpload) {
    const detail = db.assertEditableIntake(draftId);
    const document = detail.documents.find(item => item.id === documentId);
    const form = db.listLibraryForms().find(item => `form-library:${item.id}` === document?.sourceUrl);
    if (!document || !form) throw new Error('The reserved library form was not found');
    if (document.oneDriveUrl) return;
    const data = JSON.parse(detail.caseDraft!.normalizedDataJson || '{}');
    if (form.role === 'local' && courtKey(data.courtName || '') !== form.courtKey) throw new Error('The selected court changed. Replace this Local form.');
    const buffer = readFormPdf(db, form);
    const filename = intakeFileName(form.role === 'advice' ? 'Advice.pdf' : 'Local.pdf', `${draftId}:${form.id}`);
    const file = await dependencies.upload(data.intake?.storageKey, filename, buffer);
    const latest = db.assertEditableIntake(draftId);
    if (!latest.documents.some(item => item.id === documentId)) throw new Error('The library document was removed during upload');
    db.completeDocumentRetrySuccess({ documentId, originalFilename: form.filename, currentFilename: file.fileName,
        sourceUrl: document.sourceUrl, oneDriveUrl: file.webUrl, storagePath: `New filings/${data.intake.storageKey}/${file.fileName}`,
        fileSize: buffer.length, documentType: document.documentType, uploadSource: 'form_library', downloadAttempts: 1,
        metadata: { driveId: file.driveId, itemId: file.itemId } });
}

export async function applyLibraryForms(db: WorkflowDatabase, draftId: string, dependencies = productionUpload) {
    const detail = db.assertEditableIntake(draftId);
    const court = JSON.parse(detail.caseDraft!.normalizedDataJson || '{}').courtName || '';
    const available = db.listLibraryForms().filter(form => form.active && (form.role === 'advice' || form.courtKey === courtKey(court)));
    for (const form of available) {
        const documentId = db.reserveLibraryDocument(draftId, form);
        if (!documentId) continue;
        try { await uploadLibraryDocument(db, draftId, documentId, dependencies); }
        catch (error) {
            db.completeDocumentRetryFailure({ documentId, reason: error instanceof Error ? error.message : String(error), downloadAttempts: 1 });
        }
    }
    db.refreshEmailAfterDocumentRetries(detail.email.id, draftId);
    return db.refreshCaseDraftValidation(draftId);
}
