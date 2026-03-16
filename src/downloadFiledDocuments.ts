import path from 'path';
import { ParsedEmailInfo, FiledDocumentInfo } from './emailProcessor';
import { httpDownloadFromMifileToBuffer } from './mifileDownloader';
import {
    ensureRootFolder,
    ensureChildFolder,
    uploadFileBufferToFolder,
    createFileLink,
} from './oneDriveClient';
import { TrueCertifyBufferDownloader } from './truecertifyDownloader';

// === ТИПЫ ДЛЯ РЕЗУЛЬТАТОВ ===

export interface DownloadedFile {
    documentType: string | null;
    documentName?: string | null;
    localPath: string;
}

export interface NotificationFile {
    displayName: string;
    fileName: string;
    buffer: Buffer;
    driveId: string;
    itemId: string;
    webUrl?: string;
}

export interface DownloadResult {
    downloaded: DownloadedFile[];
    notificationFiles: NotificationFile[];
}

// === УТИЛИТЫ ===

function sanitizeForPath(value: string | null | undefined): string {
    if (!value) return '';
    return value.replace(/[^\w\-]+/g, '_');
}

function extractCourtNumber(courtName: string | null): string | null {
    if (!courtName) return null;
    const match = courtName.match(/\b\d{1,3}[A-Za-z0-9\-]*\b/);
    return match ? match[0] : null;
}

function firstWord(s: string | null | undefined): string | null {
    if (!s) return null;
    const trimmed = s.trim();
    if (!trimmed) return null;
    const word = trimmed.split(/\s+/)[0];
    return word || null;
}

function getDateFolderNameFromReceived(receivedAtIso?: string): string {
    let d: Date;
    if (receivedAtIso) {
        d = new Date(receivedAtIso);
        if (isNaN(d.getTime())) {
            d = new Date();
        }
    } else {
        d = new Date();
    }
    const yyyy = d.getFullYear().toString();
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    return `${yyyy}${mm}${dd}`;
}

function buildPdfFileName(parsed: ParsedEmailInfo, doc: FiledDocumentInfo): string {
    const isTypeC =
        !parsed.courtName &&
        parsed.filedDocuments.length === 1 &&
        (doc.status === 'Sent' || doc.documentType === 'SECOND_MAIL_COPY');

    if (isTypeC) {
        const caseNumberSafe = sanitizeForPath(parsed.caseNumber) || 'NO_CASE';
        const caseTitleSafe = sanitizeForPath(parsed.caseTitle);
        const docNameSafe = sanitizeForPath(doc.documentName) || 'DOC';
        const docTypeSafe = sanitizeForPath(doc.documentType ?? 'OTHER');

        const parts = [
            caseNumberSafe,
            caseTitleSafe,
            docNameSafe,
            docTypeSafe,
        ].filter(Boolean) as string[];

        return parts.join(' ') + '.pdf';
    }

    const courtNumber = extractCourtNumber(parsed.courtName);
    const courtSafe = sanitizeForPath(courtNumber);
    const caseNumberSafe = sanitizeForPath(parsed.caseNumber) || 'unknown';
    const caseTitleSafe = sanitizeForPath(parsed.caseTitle);
    const docTypeFirst = firstWord(doc.documentType ?? 'Document');
    const docTypeSafe = sanitizeForPath(docTypeFirst);
    const parts = [
        courtSafe,
        caseNumberSafe,
        caseTitleSafe,
        docTypeSafe,
    ].filter(Boolean) as string[];
    return parts.join(' ') + '.pdf';
}

function pickMainDocument(parsed: ParsedEmailInfo): FiledDocumentInfo | null {
    if (!parsed.filedDocuments.length) return null;
    return parsed.filedDocuments[0];
}

// ===== ДОПОМІЖНІ ФУНКЦІЇ ДЛЯ TRUECERTIFY =====

function extractLocatorFromUrl(url: string): string {
    const cleanUrl = url.replace(/&amp;/g, '&');
    const match = cleanUrl.match(/[?&]loc=([^&]+)/);
    return match ? match[1] : '';
}

function extractKeyFromUrl(url: string): string {
    const cleanUrl = url.replace(/&amp;/g, '&');
    const match = cleanUrl.match(/[?&]key=([^&]+)/);
    return match ? match[1] : '';
}

function looksLikePdf(buffer: Buffer): boolean {
    if (buffer.length < 100) return false;
    const header = buffer.subarray(0, 5).toString('ascii');
    return header === '%PDF-';
}

function looksLikeHtml(buffer: Buffer): boolean {
    const snippet = buffer.subarray(0, 200).toString('utf8').toLowerCase();
    return snippet.includes('<html') || snippet.includes('<!doctype html');
}

const TWO_CAPTCHA_API_KEY = process.env.TWO_CAPTCHA_API_KEY || '';
const trueCertifyDownloader = TWO_CAPTCHA_API_KEY
    ? new TrueCertifyBufferDownloader(TWO_CAPTCHA_API_KEY)
    : null;

// ===== НОВА ФУНКЦІЯ ДЛЯ TRUECERTIFY =====

export async function uploadTrueCertifyDocuments(
    parsed: ParsedEmailInfo,
    receivedAtIso?: string
): Promise<DownloadResult> {
    if (!parsed.isMiFile) return { downloaded: [], notificationFiles: [] };

    const trueCertifyDocs = parsed.filedDocuments.filter(doc =>
        doc.downloadUrl?.includes('truecertify.com')
    );

    if (trueCertifyDocs.length === 0) return { downloaded: [], notificationFiles: [] };

    if (!trueCertifyDownloader) {
        console.error('TrueCertify: TWO_CAPTCHA_API_KEY not set, cannot process TYPE C.');
        return { downloaded: [], notificationFiles: [] };
    }

    console.log(`🚀 Починаємо завантаження ${trueCertifyDocs.length} TrueCertify документів`);

    const downloaded: DownloadedFile[] = [];
    const notificationFiles: NotificationFile[] = [];

    const { driveId, itemId: rootItemId } = await ensureRootFolder();
    const dateFolderName = getDateFolderNameFromReceived(receivedAtIso);
    const dayFolderItemId = await ensureChildFolder(driveId, rootItemId, dateFolderName);

    for (const doc of trueCertifyDocs) {
        if (!doc.downloadUrl) continue;

        console.log(`\n📄 Обробка TrueCertify документа: ${doc.documentType || 'unknown'}`);

        try {
            const locator = extractLocatorFromUrl(doc.downloadUrl);
            const key = extractKeyFromUrl(doc.downloadUrl);

            if (!locator || !key) {
                throw new Error('Не вдалося отримати locator або key з URL');
            }

            console.log(`🔑 locator=${locator}, key=${key}`);

            const result = await trueCertifyDownloader.downloadToBuffer(locator, key);

            if (!result.success || !result.buffer) {
                throw new Error(
                    `TrueCertify: не удалось скачать PDF (success=${result.success}, error=${result.error})`
                );
            }

            const buffer = result.buffer;
            console.log(`TrueCertify final buffer size: ${buffer.length}`);

            if (!looksLikePdf(buffer) || looksLikeHtml(buffer)) {
                throw new Error(
                    `TrueCertify: скачан не PDF (size=${buffer.length}) — вероятно HTML/ошибка после капчи`
                );
            }

            const fileName = buildPdfFileName(parsed, doc);

            const upload = await uploadFileBufferToFolder(
                driveId,
                dayFolderItemId,
                fileName,
                buffer,
            );

            const webUrl = await createFileLink(upload.driveId, upload.itemId);

            const logicalPath = path.posix.join(dateFolderName, fileName);

            downloaded.push({
                documentType: doc.documentType ?? null,
                documentName: doc.documentName,
                localPath: logicalPath,
            });

            notificationFiles.push({
                displayName: doc.documentName ?? fileName,
                fileName: upload.fileName,
                buffer,
                driveId: upload.driveId,
                itemId: upload.itemId,
                webUrl,
            });

            console.log(`✅ TrueCertify документ загружен в OneDrive: ${logicalPath}`);
        } catch (error) {
            console.error(`❌ Критична помилка TrueCertify:`, error);
        }
    }

    return { downloaded, notificationFiles };
}

// ===== ОСНОВНА ФУНКЦІЯ =====

export async function downloadFiledDocuments(
    parsed: ParsedEmailInfo,
    _baseDir: string,
    receivedAtIso?: string
): Promise<DownloadResult> {
    if (!parsed.isMiFile) return { downloaded: [], notificationFiles: [] };
    if (!parsed.filedDocuments.length) return { downloaded: [], notificationFiles: [] };

    const trueCertifyDocs = parsed.filedDocuments.filter(doc =>
        doc.downloadUrl?.includes('truecertify.com')
    );
    const miFileDocs = parsed.filedDocuments.filter(doc =>
        !doc.downloadUrl?.includes('truecertify.com')
    );

    const downloaded: DownloadedFile[] = [];
    const notificationFiles: NotificationFile[] = [];

    // TrueCertify / TYPE C
    if (trueCertifyDocs.length > 0) {
        const trueCertifyParsed = { ...parsed, filedDocuments: trueCertifyDocs };
        const {
            downloaded: tcDownloaded,
            notificationFiles: tcNotificationFiles,
        } = await uploadTrueCertifyDocuments(trueCertifyParsed, receivedAtIso);

        downloaded.push(...tcDownloaded);
        notificationFiles.push(...tcNotificationFiles);
    }

    // MiFILE (A/B)
    if (miFileDocs.length > 0) {
        const mainDoc = pickMainDocument({ ...parsed, filedDocuments: miFileDocs });
        if (!mainDoc) return { downloaded, notificationFiles };

        const { driveId, itemId: rootItemId } = await ensureRootFolder();
        const dateFolderName = getDateFolderNameFromReceived(receivedAtIso);
        const dayFolderItemId = await ensureChildFolder(driveId, rootItemId, dateFolderName);

        for (const doc of miFileDocs) {
            if (!doc.downloadUrl) continue;

            console.log(`\n📄 Обробка MiFILE документа: ${doc.documentType || 'unknown'}`);

            const fileName = buildPdfFileName(parsed, doc);
            const buffer = await httpDownloadFromMifileToBuffer(doc.downloadUrl);

            const upload = await uploadFileBufferToFolder(
                driveId,
                dayFolderItemId,
                fileName,
                buffer,
            );

            const webUrl = await createFileLink(upload.driveId, upload.itemId);

            const logicalPath = path.posix.join(dateFolderName, fileName);

            downloaded.push({
                documentType: doc.documentType ?? null,
                documentName: doc.documentName,
                localPath: logicalPath,
            });

            notificationFiles.push({
                displayName: doc.documentName ?? fileName,
                fileName: upload.fileName,
                buffer,
                driveId: upload.driveId,
                itemId: upload.itemId,
                webUrl,
            });

            console.log(`✅ MiFILE документ загружен в OneDrive: ${logicalPath}`);
        }
    }

    return { downloaded, notificationFiles };
}
