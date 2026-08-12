import path from 'path';
import { ParsedEmailInfo, FiledDocumentInfo } from './emailProcessor';
import { httpDownloadFromMifileToBuffer } from './mifileDownloader';
import {
    ensureRootFolder,
    ensureChildFolder,
    uploadFileBufferToFolder,
    createFileLink,
    itemExistsInFolder,
} from './oneDriveClient';
import { TrueCertifyBufferDownloader } from './truecertifyDownloader';
import { validatePdfBuffer } from './pdfValidation';
import { isEmailAttachmentSource } from './emailAttachmentSource';

// === ТИПЫ ДЛЯ РЕЗУЛЬТАТОВ ===

export interface DownloadedFile {
    documentType: string | null;
    documentName?: string | null;
    localPath: string;
    downloadUrl?: string | null;
    downloadAttempts?: number;
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
    failures: DocumentFailure[];
}

export interface DocumentFailure {
    documentType: string | null;
    documentName?: string | null;
    downloadUrl?: string | null;
    reason: string;
    downloadAttempts?: number;
    attemptLog?: DocumentAttemptLog[];
}

export interface DocumentAttemptLog {
    attempt: number;
    at: string;
    stage: 'configuration' | 'preparation' | 'download' | 'validation' | 'upload';
    message: string;
}

export interface DownloadFiledDocumentsOptions {
    plaintiffShortName?: string | null;
    resolvePlaintiffNaming?: () => Promise<PlaintiffFileNaming> | PlaintiffFileNaming;
    resolveDocumentBuffer?: (document: FiledDocumentInfo) => Promise<Buffer>;
}

export interface PlaintiffFileNaming {
    fullName: string | null;
    shortName: string | null;
    mappingStatus: string;
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

function caseTitleForFile(parsed: ParsedEmailInfo, options?: DownloadFiledDocumentsOptions): string | null {
    const shortName = options?.plaintiffShortName?.trim();
    if (!shortName) return parsed.caseTitle;

    const title = parsed.caseTitle?.trim();
    if (!title) return shortName;

    const match = title.match(/^(.+?)\s+v(?:\.|s\.?)?\s+(.+)$/i);
    if (!match) return shortName;

    return `${shortName} V ${match[2].trim()}`;
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

function makeUniqueFileName(baseName: string, seen: Set<string>): string {
    const dotIndex = baseName.lastIndexOf('.');
    const nameNoExt = dotIndex > 0 ? baseName.slice(0, dotIndex) : baseName;
    const ext = dotIndex > 0 ? baseName.slice(dotIndex) : '.pdf';

    // всегда добавляем 5-символьный суффикс
    for (;;) {
        const suffix = Math.random().toString(36).slice(2, 7).toUpperCase();
        const candidate = `${nameNoExt}-${suffix}${ext}`;

        if (!seen.has(candidate)) {
            seen.add(candidate);
            return candidate;
        }
    }
}

function buildPdfFileName(
    parsed: ParsedEmailInfo,
    doc: FiledDocumentInfo,
    options?: DownloadFiledDocumentsOptions,
): string {
    const isTypeC =
        parsed.filedDocuments.length === 1 &&
        (doc.status === 'Sent' || doc.documentType === 'SECOND_MAIL_COPY');

    if (isTypeC) {
        const courtNumber = extractCourtNumber(parsed.courtName);
        const courtSafe = sanitizeForPath(courtNumber);

        const caseNumberSafe = sanitizeForPath(parsed.caseNumber) || 'NO_CASE';
        const caseTitleSafe = sanitizeForPath(caseTitleForFile(parsed, options));
        const rawDocName = doc.documentName || '';
        const docNameSafe = sanitizeForPath(rawDocName) || 'DOC';
        const docTypeSafe = sanitizeForPath(doc.documentType ?? 'OTHER');

        const parts = [
            courtSafe,       // CourtNumber
            caseNumberSafe,  // CaseNumber
            caseTitleSafe,   // CaseTitle
            // DocumentName — только если он не дублирует Title
            docNameSafe !== caseTitleSafe ? docNameSafe : '',
            docTypeSafe,     // DocumentType
        ].filter(Boolean) as string[];

        return parts.join(' ') + '.pdf';
    }

    // A/B оставляем как есть
    const courtNumber = extractCourtNumber(parsed.courtName);
    const courtSafe = sanitizeForPath(courtNumber);
    const caseNumberSafe = sanitizeForPath(parsed.caseNumber) || 'unknown';
    const caseTitleSafe = sanitizeForPath(caseTitleForFile(parsed, options));
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

function failureReason(error: unknown): string {
    if (error instanceof Error) return error.message;
    return String(error);
}

function documentDownloadAttemptLimit(): number {
    const configured = Number(process.env.DOCUMENT_IMMEDIATE_DOWNLOAD_ATTEMPTS || 3);
    if (!Number.isFinite(configured)) return 3;
    return Math.min(Math.max(Math.floor(configured), 1), 5);
}

function retryDelayMs(attempt: number): number {
    return Math.min(1_000 * 2 ** Math.min(Math.max(attempt - 1, 0), 2), 5_000);
}

async function resolvePlaintiffNaming(
    options: DownloadFiledDocumentsOptions,
): Promise<PlaintiffFileNaming> {
    const fallback: PlaintiffFileNaming = {
        fullName: null,
        shortName: options.plaintiffShortName?.trim() || null,
        mappingStatus: options.plaintiffShortName ? 'mapped_from_worker' : 'not_checked',
    };
    if (!options.resolvePlaintiffNaming) return fallback;

    try {
        const resolved = await options.resolvePlaintiffNaming();
        return {
            fullName: resolved.fullName ?? null,
            shortName: resolved.shortName?.trim() || null,
            mappingStatus: resolved.mappingStatus || 'unknown',
        };
    } catch (error) {
        console.error('Plaintiff naming lookup failed; using the full Plaintiff name:', error);
        return fallback;
    }
}

function normalizeMifileUrl(rawUrl: string): string {
    if (!rawUrl) return rawUrl;

    // раскодировать &amp; -> &
    const decoded = rawUrl.replace(/&amp;/g, '&');

    // оставить только часть до /filestampedcopy
    const marker = '/filestampedcopy';
    const idx = decoded.indexOf(marker);
    if (idx === -1) {
        return decoded;
    }

    return decoded.slice(0, idx + marker.length);
}

const TWO_CAPTCHA_API_KEY = process.env.TWO_CAPTCHA_API_KEY || '';
const trueCertifyDownloader = TWO_CAPTCHA_API_KEY
    ? new TrueCertifyBufferDownloader(TWO_CAPTCHA_API_KEY)
    : null;

// ===== НОВА ФУНКЦІЯ ДЛЯ TRUECERTIFY =====

export async function uploadTrueCertifyDocuments(
    parsed: ParsedEmailInfo,
    receivedAtIso?: string,
    options: DownloadFiledDocumentsOptions = {},
): Promise<DownloadResult> {
    if (!parsed.isMiFile) return { downloaded: [], notificationFiles: [], failures: [] };

    const trueCertifyDocs = parsed.filedDocuments.filter(doc =>
        doc.downloadUrl?.includes('truecertify.com')
    );

    if (trueCertifyDocs.length === 0) return { downloaded: [], notificationFiles: [], failures: [] };

    if (!trueCertifyDownloader) {
        console.error('TrueCertify: TWO_CAPTCHA_API_KEY not set, cannot process TYPE C.');
        return {
            downloaded: [],
            notificationFiles: [],
            failures: trueCertifyDocs.map(doc => ({
                documentType: doc.documentType ?? null,
                documentName: doc.documentName,
                downloadUrl: doc.downloadUrl,
                reason: 'TrueCertify: TWO_CAPTCHA_API_KEY not set',
                downloadAttempts: 0,
                attemptLog: [{
                    attempt: 0,
                    at: new Date().toISOString(),
                    stage: 'configuration',
                    message: 'TWO_CAPTCHA_API_KEY is not set',
                }],
            })),
        };
    }

    console.log(`🚀 Починаємо завантаження ${trueCertifyDocs.length} TrueCertify документів`);

    const downloaded: DownloadedFile[] = [];
    const notificationFiles: NotificationFile[] = [];
    const failures: DocumentFailure[] = [];

    const fileNamesSeen = new Set<string>();

    const { driveId, itemId: rootItemId } = await ensureRootFolder();
    const dateFolderName = getDateFolderNameFromReceived(receivedAtIso);
    const dayFolderItemId = await ensureChildFolder(driveId, rootItemId, dateFolderName);

    for (const doc of trueCertifyDocs) {
        if (!doc.downloadUrl) {
            failures.push({
                documentType: doc.documentType ?? null,
                documentName: doc.documentName,
                downloadUrl: null,
                reason: 'Missing TrueCertify download URL',
                downloadAttempts: 0,
                attemptLog: [{
                    attempt: 0,
                    at: new Date().toISOString(),
                    stage: 'preparation',
                    message: 'Missing TrueCertify download URL',
                }],
            });
            continue;
        }

        console.log(`\n📄 Обробка TrueCertify документа: ${doc.documentType || 'unknown'}`);

        let downloadAttempts = 0;
        let processingStage: DocumentAttemptLog['stage'] = 'preparation';
        let attemptLog: DocumentAttemptLog[] = [];
        try {
            const locator = extractLocatorFromUrl(doc.downloadUrl);
            const key = extractKeyFromUrl(doc.downloadUrl);

            if (!locator || !key) {
                throw new Error('Не вдалося отримати locator або key з URL');
            }

            console.log(`🔑 locator=${locator}, key=${key}`);

            processingStage = 'download';
            const result = await trueCertifyDownloader.downloadToBuffer(locator, key);
            downloadAttempts = result.attempts;
            attemptLog = result.attemptLog;

            if (!result.success || !result.buffer) {
                throw new Error(
                    `TrueCertify: не удалось скачать PDF (success=${result.success}, error=${result.error})`
                );
            }

            const buffer = result.buffer;
            console.log(`TrueCertify final buffer size: ${buffer.length}`);

            const validation = validatePdfBuffer(buffer);
            if (!validation.valid) {
                processingStage = 'validation';
                throw new Error(
                    `TrueCertify: downloaded content is not a valid PDF (${validation.reason})`
                );
            }

            processingStage = 'upload';
            const plaintiffNaming = await resolvePlaintiffNaming(options);
            console.log('Plaintiff naming lookup:', {
                documentType: doc.documentType ?? null,
                fullName: plaintiffNaming.fullName,
                shortName: plaintiffNaming.shortName,
                mappingStatus: plaintiffNaming.mappingStatus,
            });
            let baseName = buildPdfFileName(parsed, doc, {
                ...options,
                plaintiffShortName: plaintiffNaming.shortName,
            });
            let fileName = makeUniqueFileName(baseName, fileNamesSeen);
            console.log('OneDrive file name selected:', fileName);

// доп. проверка в OneDrive: если файл с таким именем уже есть в папке — добавляем ещё 5-символьный суффикс
            if (await itemExistsInFolder(driveId, dayFolderItemId, fileName)) {
                const dotIndex = fileName.lastIndexOf('.');
                const nameNoExt = dotIndex > 0 ? fileName.slice(0, dotIndex) : fileName;
                const ext = dotIndex > 0 ? fileName.slice(dotIndex) : '.pdf';

                for (;;) {
                    const suffix = Math.random().toString(36).slice(2, 7).toUpperCase();
                    const candidate = `${nameNoExt}-${suffix}${ext}`;
                    if (!(await itemExistsInFolder(driveId, dayFolderItemId, candidate))) {
                        fileName = candidate;
                        break;
                    }
                }
            }

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
                downloadUrl: doc.downloadUrl,
                downloadAttempts,
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
            const reason = failureReason(error);
            if (attemptLog[attemptLog.length - 1]?.message !== reason) {
                attemptLog.push({
                    attempt: downloadAttempts,
                    at: new Date().toISOString(),
                    stage: processingStage,
                    message: reason,
                });
            }
            failures.push({
                documentType: doc.documentType ?? null,
                documentName: doc.documentName,
                downloadUrl: doc.downloadUrl,
                reason,
                downloadAttempts,
                attemptLog,
            });
        }
    }

    return { downloaded, notificationFiles, failures };
}

// ===== ОСНОВНА ФУНКЦІЯ =====

export async function downloadFiledDocuments(
    parsed: ParsedEmailInfo,
    _baseDir: string,
    receivedAtIso?: string,
    options: DownloadFiledDocumentsOptions = {},
): Promise<DownloadResult> {
    if (!parsed.isMiFile) return { downloaded: [], notificationFiles: [], failures: [] };
    if (!parsed.filedDocuments.length) {
        return {
            downloaded: [],
            notificationFiles: [],
            failures: [
                {
                    documentType: null,
                    documentName: null,
                    downloadUrl: null,
                    reason: 'No filed documents found in parsed email',
                },
            ],
        };
    }

    const trueCertifyDocs = parsed.filedDocuments.filter(doc =>
        doc.downloadUrl?.includes('truecertify.com')
    );
    const miFileDocs = parsed.filedDocuments.filter(doc =>
        !doc.downloadUrl?.includes('truecertify.com')
    );

    const downloaded: DownloadedFile[] = [];
    const notificationFiles: NotificationFile[] = [];
    const failures: DocumentFailure[] = [];

    // TrueCertify / TYPE C
    if (trueCertifyDocs.length > 0) {
        const trueCertifyParsed = { ...parsed, filedDocuments: trueCertifyDocs };
        const {
            downloaded: tcDownloaded,
            notificationFiles: tcNotificationFiles,
            failures: tcFailures,
        } = await uploadTrueCertifyDocuments(trueCertifyParsed, receivedAtIso, options);

        downloaded.push(...tcDownloaded);
        notificationFiles.push(...tcNotificationFiles);
        failures.push(...tcFailures);
    }

    // MiFILE (A/B)
    if (miFileDocs.length > 0) {
        const mainDoc = pickMainDocument({ ...parsed, filedDocuments: miFileDocs });
        if (!mainDoc) return { downloaded, notificationFiles, failures };

        const { driveId, itemId: rootItemId } = await ensureRootFolder();
        const dateFolderName = getDateFolderNameFromReceived(receivedAtIso);
        const dayFolderItemId = await ensureChildFolder(driveId, rootItemId, dateFolderName);

        const fileNamesSeen = new Set<string>();

        for (const doc of miFileDocs) {
            if (!doc.downloadUrl) {
                failures.push({
                    documentType: doc.documentType ?? null,
                    documentName: doc.documentName,
                    downloadUrl: null,
                    reason: 'Missing MiFILE download URL',
                    downloadAttempts: 0,
                    attemptLog: [{
                        attempt: 0,
                        at: new Date().toISOString(),
                        stage: 'preparation',
                        message: 'Missing MiFILE download URL',
                    }],
                });
                continue;
            }

            console.log(`\n📄 Обробка MiFILE документа: ${doc.documentType || 'unknown'}`);

            let buffer: Buffer | null = null;

            const maxRetries = documentDownloadAttemptLimit();
            let downloadAttempts = 0;
            const attemptLog: DocumentAttemptLog[] = [];
            let lastFailureReason = 'Unknown download failure';

            try {

            for (let attempt = 1; attempt <= maxRetries; attempt++) {
                downloadAttempts = attempt;
                try {
                    console.log(
                        `📥 Завантажуємо MiFILE документ (спроба ${attempt}/${maxRetries})`,
                    );

                    let downloadedBuf: Buffer;
                    if (isEmailAttachmentSource(doc.downloadUrl)) {
                        if (!options.resolveDocumentBuffer) {
                            throw new Error('The source email attachment is not available to this retry');
                        }
                        console.log('Downloading PDF attachment from the source email:', doc.documentName);
                        downloadedBuf = await options.resolveDocumentBuffer(doc);
                    } else {
                        const url = normalizeMifileUrl(doc.downloadUrl);
                        console.log('MiFILE raw URL:', doc.downloadUrl);
                        console.log('MiFILE normalized URL:', url);
                        downloadedBuf = await httpDownloadFromMifileToBuffer(url);
                    }

                    const validation = validatePdfBuffer(downloadedBuf);
                    if (!validation.valid) {
                        throw new Error(
                            `Downloaded content failed PDF validation: ${validation.reason}`,
                        );
                    }

                    buffer = downloadedBuf;
                    break; // успех
                } catch (err) {
                    lastFailureReason = failureReason(err);
                    attemptLog.push({
                        attempt,
                        at: new Date().toISOString(),
                        stage: lastFailureReason.includes('PDF validation')
                            ? 'validation'
                            : 'download',
                        message: lastFailureReason,
                    });
                    console.error(
                        `❌ Помилка при завантаженні MiFILE (спроба ${attempt}):`,
                        err,
                    );
                    if (attempt === maxRetries) {
                        console.error(
                            `❌ MiFILE: не вдалося завантажити документ після ${maxRetries} спроб, пропускаємо`,
                        );
                    } else {
                        await new Promise(res => setTimeout(res, retryDelayMs(attempt)));
                    }
                }
            }

            if (!buffer) {
                failures.push({
                    documentType: doc.documentType ?? null,
                    documentName: doc.documentName,
                    downloadUrl: doc.downloadUrl,
                    reason: `MiFILE: failed after ${maxRetries} immediate attempt(s). Last error: ${lastFailureReason}`,
                    downloadAttempts,
                    attemptLog,
                });
                continue; // не удалось получить валидный PDF – не грузим в OneDrive
            }

            const plaintiffNaming = await resolvePlaintiffNaming(options);
            console.log('Plaintiff naming lookup:', {
                documentType: doc.documentType ?? null,
                fullName: plaintiffNaming.fullName,
                shortName: plaintiffNaming.shortName,
                mappingStatus: plaintiffNaming.mappingStatus,
            });
            const baseName = buildPdfFileName(parsed, doc, {
                ...options,
                plaintiffShortName: plaintiffNaming.shortName,
            });
            let fileName = makeUniqueFileName(baseName, fileNamesSeen);
            console.log('OneDrive file name selected:', fileName);

            if (await itemExistsInFolder(driveId, dayFolderItemId, fileName)) {
                const dotIndex = fileName.lastIndexOf('.');
                const nameNoExt = dotIndex > 0 ? fileName.slice(0, dotIndex) : fileName;
                const ext = dotIndex > 0 ? fileName.slice(dotIndex) : '.pdf';

                for (;;) {
                    const suffix = Math.random().toString(36).slice(2, 7).toUpperCase();
                    const candidate = `${nameNoExt}-${suffix}${ext}`;
                    if (!(await itemExistsInFolder(driveId, dayFolderItemId, candidate))) {
                        fileName = candidate;
                        break;
                    }
                }
            }

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
                downloadUrl: doc.downloadUrl,
                downloadAttempts,
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
            } catch (error) {
                console.error('Critical MiFILE document processing error:', error);
                const reason = failureReason(error);
                attemptLog.push({
                    attempt: downloadAttempts,
                    at: new Date().toISOString(),
                    stage: buffer ? 'upload' : 'download',
                    message: reason,
                });
                failures.push({
                    documentType: doc.documentType ?? null,
                    documentName: doc.documentName,
                    downloadUrl: doc.downloadUrl,
                    reason,
                    downloadAttempts,
                    attemptLog,
                });
            }
        }
    }

    return { downloaded, notificationFiles, failures };
}
