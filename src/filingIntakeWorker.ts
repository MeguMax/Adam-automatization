import type { WorkflowDatabase } from './database';
import type { ParsedEmailInfo } from './emailProcessor';
import type { DownloadResult } from './downloadFiledDocuments';
import { ComplaintExtractionResult } from './complaintExtractor';
import { recognizeDocumentPdf } from './documentRecognition';
import { applyLibraryForms, type FormUploadDependencies } from './formLibrary';
import type { WorkerPhase } from './workerHealth';

export async function processFilingIntake(
    db: WorkflowDatabase,
    emailId: string,
    draftId: string,
    parsed: ParsedEmailInfo,
    dependencies: {
        download(parsed: ParsedEmailInfo): Promise<DownloadResult>;
        extract(buffer: Buffer, documentType: string | null): Promise<ComplaintExtractionResult>;
        recognize?: typeof recognizeDocumentPdf;
        forms?: FormUploadDependencies;
        progress?: (phase:WorkerPhase)=>void;
        deferEmailRefresh?: boolean;
    },
) {
    const initial = db.getDraftDetail(draftId);
    if (!initial?.caseDraft) throw new Error('Intake Draft not found');
    if (initial.caseDraft.filingStatus === 'queued' || ['filing_in_progress', 'filing_reconciliation', 'filing_prepared', 'filed_successfully', 'archived']
        .includes(initial.caseDraft.status)) {
        throw new Error('This Draft cannot be reprocessed in its current filing state');
    }
    for (const source of parsed.filedDocuments) {
        const current = db.getDraftDetail(draftId)!;
        const nameMatches = current.documents.filter(item => item.originalFilename === source.documentName);
        const document = current.documents.find(item => item.sourceUrl === source.downloadUrl) ||
            (nameMatches.length === 1 ? nameMatches[0] : undefined);
        // A removed source document stays removed on reprocessing.
        if (!document || !document.sourceUrl || document.oneDriveUrl || document.status === 'uploaded') continue;
        let uploaded=false;
        try {
            dependencies.progress?.('downloading_pdf');
            const stableSource = { ...source, downloadUrl: document.sourceUrl || source.downloadUrl };
            const result = await dependencies.download({ ...parsed, filedDocuments: [stableSource] });
            const file = result.notificationFiles[0];
            const downloaded = result.downloaded[0];
            if (!file || !downloaded) {
                const failure = result.failures[0];
                db.completeDocumentRetryFailure({
                    documentId: document.id,
                    reason: failure?.reason || 'No PDF was uploaded',
                    downloadAttempts: failure?.downloadAttempts || 0,
                    metadata: failure,
                });
                continue;
            }
            db.completeDocumentRetrySuccess({
                documentId: document.id,
                originalFilename: source.documentName || file.displayName,
                currentFilename: file.fileName,
                sourceUrl: stableSource.downloadUrl,
                oneDriveUrl: file.webUrl || null,
                storagePath: downloaded.localPath,
                fileSize: file.buffer.length,
                documentType: source.documentType,
                uploadSource: 'email_intake',
                downloadAttempts: downloaded.downloadAttempts || 1,
                metadata: { driveId: file.driveId, itemId: file.itemId },
            });
            uploaded=true;
            // An uploaded PDF remains uploaded even if its later recognition fails.
            try {
                dependencies.progress?.('recognizing_pdf');
                const recognition = downloaded.recognition || await (dependencies.recognize || recognizeDocumentPdf)(file.buffer, source.documentName || file.displayName);
                db.recordDocumentRecognition(document.id, recognition);
                if (recognition.role === 'complaint' && recognition.source !== 'conflict') {
                    try {
                        dependencies.progress?.('extracting_complaint');
                        const extraction = await dependencies.extract(file.buffer, source.documentType);
                        db.applyComplaintExtraction(draftId, document.id, extraction);
                    } catch (error) {
                        db.recordComplaintExtractionFailure(draftId, document.id, error);
                    }
                }
            } catch(error) {
                db.recordDocumentRecognitionFailure(document.id,error);
            }
        } catch (error) {
            if(uploaded)throw error;
            db.completeDocumentRetryFailure({
                documentId: document.id,
                reason: error instanceof Error ? error.message : String(error),
                downloadAttempts: 0,
            });
        }
    }
    if (!dependencies.deferEmailRefresh) {
        if (parsed.filedDocuments.length) db.refreshEmailAfterDocumentRetries(emailId);
        else db.markEmailProcessed(emailId);
    }
    dependencies.progress?.('adding_forms');
    const current = db.getDraftDetail(draftId)!;
    if (!parsed.intake?.packageKey || current.documents.some(document => document.packageRole === 'complaint')) {
        await applyLibraryForms(db, draftId, dependencies.forms, { refreshEmail: !dependencies.deferEmailRefresh });
    }
    db.recordIntakeProcessingFailure(draftId, null);
    return db.refreshCaseDraftValidation(draftId);
}
