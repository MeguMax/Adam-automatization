import type { DownloadResult, DocumentAttemptLog } from './downloadFiledDocuments';
import type { ParsedEmailInfo, FiledDocumentInfo } from './emailProcessor';
import { INTAKE_MAX_PDF_BYTES, intakeFileName } from './filingIntake';
import { inspectFilingPdf, validatePdfBuffer } from './pdfValidation';

export interface IntakeDownloadDependencies {
    download(document: FiledDocumentInfo): Promise<Buffer>;
    upload(storageKey: string, fileName: string, buffer: Buffer): Promise<{
        driveId: string; itemId: string; fileName: string; webUrl: string;
    }>;
    wait(ms: number): Promise<void>;
}

export async function downloadIntakeDocuments(
    parsed: ParsedEmailInfo,
    dependencies: IntakeDownloadDependencies,
): Promise<DownloadResult> {
    if (!parsed.intake || !/^[a-f0-9]{24}$/.test(parsed.intake.storageKey)) {
        throw new Error('The intake package has no valid storage identity');
    }
    const result: DownloadResult = { downloaded: [], notificationFiles: [], failures: [] };
    for (const document of parsed.filedDocuments) {
        const attemptLog: DocumentAttemptLog[] = [];
        let attempts = 0;
        let stage: DocumentAttemptLog['stage'] = 'download';
        let buffer: Buffer | undefined;
        let complete = false;
        let inspected = false;
        for (let attempt = 1; attempt <= 3; attempt++) {
            attempts = attempt;
            try {
                stage = 'download';
                buffer ??= await dependencies.download(document);
                stage = 'validation';
                const validation = validatePdfBuffer(buffer);
                if (!validation.valid) throw new Error(validation.reason || 'Invalid PDF');
                if (buffer.length > INTAKE_MAX_PDF_BYTES) {
                    throw new Error('The PDF exceeds the 25 MB filing limit. Replace it with a smaller PDF.');
                }
                if (!inspected) {
                    await inspectFilingPdf(buffer);
                    inspected = true;
                }
                stage = 'upload';
                const fileName = intakeFileName(document.documentName || 'Document.pdf', document.downloadUrl || '');
                const uploaded = await dependencies.upload(parsed.intake.storageKey, fileName, buffer);
                result.downloaded.push({
                    documentName: document.documentName,
                    documentType: document.documentType,
                    downloadUrl: document.downloadUrl,
                    downloadAttempts: attempts,
                    localPath: `New filings/${parsed.intake.storageKey}/${uploaded.fileName}`,
                });
                result.notificationFiles.push({
                    ...uploaded,
                    buffer,
                    displayName: document.documentName || uploaded.fileName,
                });
                complete = true;
                break;
            } catch (error) {
                attemptLog.push({
                    attempt, at: new Date().toISOString(), stage,
                    message: error instanceof Error ? error.message : String(error),
                });
                // Invalid source attachments need correction, not repeated immediate downloads.
                if (stage === 'validation') break;
                if (attempt < 3) await dependencies.wait(1_000 * attempt);
            }
        }
        if (!complete) result.failures.push({
            documentName: document.documentName,
            documentType: document.documentType,
            downloadUrl: document.downloadUrl,
            reason: attemptLog[attemptLog.length - 1]?.message || 'Attachment processing failed',
            downloadAttempts: attempts,
            attemptLog,
        });
    }
    return result;
}
