// mifileDownloader.ts
import fetch from 'node-fetch';
import { getMifileCookieHeader, invalidateMifileSession } from './mifileSession';
import { TrueCertifyBufferDownloader } from './truecertifyDownloader';

const twoCaptchaApiKey = process.env.TWO_CAPTCHA_API_KEY;
if (!twoCaptchaApiKey) {
    throw new Error('TWO_CAPTCHA_API_KEY is not set in environment');
}

// Один инстанс на процесс
const trueCertifyDownloader = new TrueCertifyBufferDownloader(twoCaptchaApiKey);

export class MifileDocumentNotDownloadableError extends Error {
    readonly code = 'MIFILE_DOCUMENT_NOT_DOWNLOADABLE';
    readonly nonRetryable = true;

    constructor(message: string) {
        super(message);
        this.name = 'MifileDocumentNotDownloadableError';
    }
}

export function isMifileDocumentNotDownloadableError(
    error: unknown,
): error is MifileDocumentNotDownloadableError {
    return error instanceof MifileDocumentNotDownloadableError ||
        (typeof error === 'object' && error !== null &&
            (error as { code?: string }).code === 'MIFILE_DOCUMENT_NOT_DOWNLOADABLE');
}

function responseSummary(buffer: Buffer | null): string | null {
    if (!buffer?.length) return null;
    const text = buffer.toString('utf8').replace(/\s+/g, ' ').trim();
    return text ? text.slice(0, 240) : null;
}

function historyStampedCopyUrl(url: string): string | null {
    try {
        const parsed = new URL(url);
        const filingId = parsed.pathname.match(/\/filing\/([^/]+)/i)?.[1];
        if (!filingId) return null;
        return `${parsed.origin}/filing/${encodeURIComponent(filingId)}/download/stamped`;
    } catch {
        return null;
    }
}

function isStructuredElectronicForm(buffer: Buffer | null): boolean {
    if (!buffer?.length) return false;
    const prefix = buffer.toString('utf8', 0, Math.min(buffer.length, 64)).trimStart();
    if (!prefix.startsWith('{')) return false;
    try {
        const value = JSON.parse(buffer.toString('utf8')) as Record<string, unknown>;
        return 'representationType' in value ||
            'caseParticipants' in value ||
            'caseOfficial' in value;
    } catch {
        return false;
    }
}

export async function httpDownloadFromMifile(url: string, targetPath: string): Promise<void> {
    const buffer = await httpDownloadFromMifileToBuffer(url);
    const fs = await import('fs/promises');
    await fs.writeFile(targetPath, buffer);
}

/**
 * Новый вариант: скачивает файл по URL и возвращает Buffer.
 * Поддерживает и MiFILE, и TrueCertify.
 */
export async function httpDownloadFromMifileToBuffer(url: string): Promise<Buffer> {
    // TrueCertify
    if (url.includes('truecertify.com')) {
        console.log('🔍 Виявлено TrueCertify URL, використовуємо buffer-завантажувач');

        // Чистим &amp;
        const cleanUrl = url.replace(/&amp;/g, '&');
        const urlObj = new URL(cleanUrl);
        const locator = urlObj.searchParams.get('loc');
        const key = urlObj.searchParams.get('key');

        if (!locator || !key) {
            throw new Error('Не вдалося отримати locator або key з TrueCertify URL');
        }

        console.log(`📥 Завантажуємо TrueCertify документ: locator=${locator}, key=${key}`);

        const result = await trueCertifyDownloader.downloadToBuffer(locator, key);

        if (!result.success || !result.buffer) {
            throw new Error(`Помилка завантаження TrueCertify: ${result.error}`);
        }

        console.log(`✅ TrueCertify документ завантажено, розмір: ${result.buffer.length} байт`);
        return result.buffer;
    }

    // MiFILE
    console.log('📥 Завантажуємо MiFILE документ');
    let cookieHeader = await getMifileCookieHeader();
    const configuredTimeout = Number(process.env.MIFILE_DOWNLOAD_TIMEOUT_MS || 90000);
    const timeoutMs = Number.isFinite(configuredTimeout)
        ? Math.min(Math.max(Math.floor(configuredTimeout), 10000), 300000)
        : 90000;

    const doFetch = async (requestUrl = url) => {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), timeoutMs);
        try {
            const response = await fetch(requestUrl, {
                method: 'GET',
                headers: {
                    Cookie: cookieHeader,
                },
                signal: controller.signal,
            });
            const buffer = Buffer.from(await response.arrayBuffer());
            return { response, buffer };
        } catch (error) {
            if ((error as { name?: string }).name === 'AbortError') {
                throw new Error(`MiFILE download timed out after ${timeoutMs} ms`);
            }
            throw error;
        } finally {
            clearTimeout(timeout);
        }
    };

    let download = await doFetch();
    let res = download.response;

    const isLoginPageResponse = () => {
        const contentType = res.headers.get('content-type')?.toLowerCase() ?? '';
        return res.url.toLowerCase().includes('/login?returnurl=') ||
            (contentType.includes('text/html') && !!download.buffer);
    };

    if (isLoginPageResponse()) {
        console.warn('MiFILE returned the login page instead of a PDF; refreshing authentication.');
        invalidateMifileSession();
        cookieHeader = await getMifileCookieHeader(true);
        download = await doFetch();
        res = download.response;
        if (isLoginPageResponse()) {
            throw new Error('MiFILE redirected the download to its login page after session refresh');
        }
    }

    if (!res.ok) {
        console.warn(`⚠️ MiFILE HTTP ${res.status} for URL: ${url}`);

        // Один повторный запрос для временных глюков с паузой 3 секунды
        if (res.status === 400 || res.status === 500 || res.status === 502 || res.status === 503) {
            console.warn('🔁 Повторная спроба завантаження з MiFILE через 3 секунди...');
            await new Promise(resolve => setTimeout(resolve, 3000));
            download = await doFetch();
            res = download.response;
        }

        if (!res.ok) {
            const primaryStatus = res.status;
            const primaryDetail = responseSummary(download.buffer);
            const fallbackUrl = historyStampedCopyUrl(url);

            if (fallbackUrl) {
                console.warn('MiFILE direct document link failed; trying the filing history endpoint.');
                download = await doFetch(fallbackUrl);
                res = download.response;

                if (res.ok && isStructuredElectronicForm(download.buffer)) {
                    throw new MifileDocumentNotDownloadableError(
                        'MiFILE has no downloadable PDF for this electronic filing; ' +
                        'filing history returned structured form data instead of a PDF',
                    );
                }
                if (res.ok && download.buffer.length) {
                    console.log('MiFILE document recovered through filing history.');
                    return download.buffer;
                }
            }

            const fallbackDetail = responseSummary(download.buffer);
            const detail = fallbackDetail || primaryDetail;
            throw new Error(
                `HTTP ${primaryStatus} when downloading from MiFILE` +
                (detail ? `: ${detail}` : ''),
            );
        }
    }

    if (!download.buffer) {
        throw new Error('MiFILE returned an empty download body');
    }
    return download.buffer;
}
