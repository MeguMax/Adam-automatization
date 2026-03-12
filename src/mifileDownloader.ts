// mifileDownloader.ts
import fetch from 'node-fetch';
import { getMifileCookieHeader } from './mifileSession';
import { TrueCertifyBufferDownloader } from './truecertifyDownloader';

const twoCaptchaApiKey = process.env.TWO_CAPTCHA_API_KEY;
if (!twoCaptchaApiKey) {
    throw new Error('TWO_CAPTCHA_API_KEY is not set in environment');
}

// Один инстанс на процесс
const trueCertifyDownloader = new TrueCertifyBufferDownloader(twoCaptchaApiKey);

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
    const cookieHeader = await getMifileCookieHeader();

    const doFetch = async () => {
        const res = await fetch(url, {
            method: 'GET',
            headers: {
                Cookie: cookieHeader,
            },
        });
        return res;
    };

    let res = await doFetch();

    if (!res.ok) {
        console.warn(`⚠️ MiFILE HTTP ${res.status} for URL: ${url}`);

        // Один повторный запрос для временных глюков с паузой 3 секунды
        if (res.status === 400 || res.status === 500 || res.status === 502 || res.status === 503) {
            console.warn('🔁 Повторная спроба завантаження з MiFILE через 3 секунди...');
            await new Promise(resolve => setTimeout(resolve, 3000));
            res = await doFetch();
        }

        if (!res.ok) {
            throw new Error(`HTTP ${res.status} when downloading from MiFILE`);
        }
    }

    const arrayBuffer = await res.arrayBuffer();
    return Buffer.from(arrayBuffer);
}
