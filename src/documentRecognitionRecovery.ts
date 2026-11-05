import type { DocumentRecognition } from './documentRecognition';

export const DOCUMENT_RECOGNITION_ATTEMPTS = 3;

export interface RecognitionRecovery {
    sourceVersion: string;
    attempts: number;
    lastError: string;
    nextRetryAt: string | null;
    status?: 'queued' | 'reading' | 'failed';
    startedAt?: string;
}

type RecognitionDocument = {
    recognition?: DocumentRecognition | null;
    recognitionRecovery?: RecognitionRecovery | null;
    sourceVersion?: string | null;
};

export function needsDocumentRecognition(document: RecognitionDocument): boolean {
    return Boolean(document.recognitionRecovery) || (document.recognition?.recognitionVersion || 0) < 2 ||
        (document.recognition?.pdfVerified === undefined && document.recognition?.source !== 'content') ||
        !/^[a-f0-9]{64}$/.test(document.recognition?.contentHash || '');
}

export function documentRecognitionDue(document: RecognitionDocument, now = Date.now()): boolean {
    if (!needsDocumentRecognition(document)) return false;
    const retry = document.recognitionRecovery;
    return !retry || (retry.status !== 'reading' && retry.attempts < DOCUMENT_RECOGNITION_ATTEMPTS &&
        !(Date.parse(retry.nextRetryAt || '') > now));
}

export function recognitionErrorSummary(error: unknown): string {
    return (error instanceof Error ? error.message : String(error)).split(/\r?\n/, 1)[0]
        .replace(/^\w*Error:\s*/, '').slice(0, 500) || 'PDF recognition failed';
}
