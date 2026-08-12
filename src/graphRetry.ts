export interface GraphRetryOptions {
    maxAttempts?: number;
    baseDelayMs?: number;
    maxDelayMs?: number;
    label?: string;
    onRetry?: (details: {
        attempt: number;
        maxAttempts: number;
        delayMs: number;
        reason: string;
    }) => void;
}

function errorText(error: unknown): string {
    if (error instanceof Error) return error.message;
    if (error && typeof error === 'object') {
        const value = error as Record<string, unknown>;
        return String(value.body ?? value.message ?? value.code ?? error);
    }
    return String(error);
}

export function graphErrorReason(error: unknown): string {
    const statusCode = Number(
        error && typeof error === 'object'
            ? (error as Record<string, unknown>).statusCode
            : NaN,
    );
    const status = Number.isFinite(statusCode) ? `HTTP ${statusCode}: ` : '';
    return `${status}${errorText(error)}`.slice(0, 500);
}

export function isRetryableGraphError(error: unknown): boolean {
    if (error instanceof SyntaxError) return true;
    if (!error || typeof error !== 'object') return false;

    const value = error as Record<string, unknown>;
    const statusCode = Number(value.statusCode);
    if ([408, 409, 425, 429, 500, 502, 503, 504].includes(statusCode)) {
        return true;
    }
    if (statusCode >= 400 && statusCode < 500) return false;

    const code = String(value.code ?? '').toUpperCase();
    if ([
        'ECONNRESET',
        'ECONNREFUSED',
        'EPIPE',
        'ENETDOWN',
        'ENETRESET',
        'ENETUNREACH',
        'ETIMEDOUT',
        'UND_ERR_SOCKET',
    ].includes(code)) {
        return true;
    }

    const text = errorText(error).toLowerCase();
    return (
        text.includes('json') ||
        text.includes('unexpected end') ||
        text.includes('expected \',\' or \']\'') ||
        text.includes('terminated') ||
        text.includes('socket') ||
        text.includes('fetch failed')
    );
}

function boundedInteger(
    value: number | undefined,
    fallback: number,
    min: number,
    max: number,
): number {
    if (!Number.isFinite(value)) return fallback;
    return Math.min(Math.max(Math.floor(value as number), min), max);
}

export async function withGraphRetry<T>(
    operation: () => Promise<T>,
    options: GraphRetryOptions = {},
): Promise<T> {
    const maxAttempts = boundedInteger(options.maxAttempts, 5, 1, 10);
    const baseDelayMs = boundedInteger(options.baseDelayMs, 1_000, 0, 60_000);
    const maxDelayMs = boundedInteger(options.maxDelayMs, 15_000, 0, 120_000);

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        try {
            return await operation();
        } catch (error) {
            if (attempt >= maxAttempts || !isRetryableGraphError(error)) {
                throw error;
            }

            const delayMs = Math.min(baseDelayMs * 2 ** (attempt - 1), maxDelayMs);
            options.onRetry?.({
                attempt,
                maxAttempts,
                delayMs,
                reason: graphErrorReason(error),
            });
            if (delayMs > 0) {
                await new Promise(resolve => setTimeout(resolve, delayMs));
            }
        }
    }

    throw new Error(`${options.label || 'Microsoft Graph request'} exhausted retries`);
}
