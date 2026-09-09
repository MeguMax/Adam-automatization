import type { WorkflowDatabase } from './database';
import type { ParsedEmailInfo } from './emailProcessor';
import type { DownloadResult } from './downloadFiledDocuments';
import { isComplaintDocument, ComplaintExtractionResult } from './complaintExtractor';

export async function processFilingIntake(
    db: WorkflowDatabase,
    emailId: string,
    draftId: string,
    parsed: ParsedEmailInfo,
    dependencies: {
        download(parsed: ParsedEmailInfo): Promise<DownloadResult>;
        extract(buffer: Buffer, documentType: string | null): Promise<ComplaintExtractionResult>;
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
        if (!document || document.oneDriveUrl || document.status === 'uploaded') continue;
        try {
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
            if (isComplaintDocument(source.documentType, source.documentName)) {
                try {
                    const extraction = await dependencies.extract(file.buffer, source.documentType);
                    db.applyComplaintExtraction(draftId, document.id, extraction);
                } catch (error) {
                    db.recordComplaintExtractionFailure(draftId, document.id, error);
                }
            }
        } catch (error) {
            db.completeDocumentRetryFailure({
                documentId: document.id,
                reason: error instanceof Error ? error.message : String(error),
                downloadAttempts: 0,
            });
        }
    }
    if (parsed.filedDocuments.length) db.refreshEmailAfterDocumentRetries(emailId, draftId);
    else db.markEmailProcessed(emailId);
    return db.refreshCaseDraftValidation(draftId);
}
