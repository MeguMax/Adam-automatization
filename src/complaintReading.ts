export const COMPLAINT_READING_ATTEMPTS = 3;

export interface ComplaintReadingView {
    status: 'unavailable' | 'not_started' | 'queued' | 'reading' | 'retry_scheduled' | 'stopped' | 'complete';
    attempts: number;
    maxAttempts: number;
    nextRetryAt: string | null;
    startedAt: string | null;
    lastError: string | null;
    canRetry: boolean;
}

export function complaintReadingView(data: unknown, available: boolean, editable: boolean): ComplaintReadingView {
    const root = data && typeof data === 'object' ? data as Record<string, any> : {};
    const state = root.complaintAutoExtraction || {};
    const date = (value: unknown) => typeof value === 'string' && Number.isFinite(Date.parse(value)) ? value : null;
    const attempts = Number.isFinite(Number(state.attempts)) ? Math.max(0, Math.floor(Number(state.attempts))) : 0;
    const error = typeof root.complaintExtractionError === 'string' ? root.complaintExtractionError.trim()
        .split(/\r?\n/, 1)[0].replace(/^\w*Error:\s*/, '').slice(0, 500) : null;
    const nextRetryAt = attempts < COMPLAINT_READING_ATTEMPTS ? date(state.nextRetryAt) : null;
    const status = !available ? 'unavailable' : state.status === 'queued' ? 'queued' : state.status === 'running' ? 'reading' :
        error ? nextRetryAt ? 'retry_scheduled' : 'stopped' : root.complaintExtraction ? 'complete' : 'not_started';
    return { status, attempts, maxAttempts: COMPLAINT_READING_ATTEMPTS, nextRetryAt,
        startedAt: date(state.startedAt), lastError: error,
        canRetry: available && editable && !['queued', 'reading'].includes(status) };
}
