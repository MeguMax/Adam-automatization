import 'dotenv/config';
import { Client, ResponseType } from '@microsoft/microsoft-graph-client';
import { ClientSecretCredential } from '@azure/identity';
import 'isomorphic-fetch';
import { graphErrorReason, withGraphRetry } from './graphRetry';

export interface FiledDocumentInfo {
    documentName?: string | null;      // для single-док писем
    documentType: string | null;
    status: string | null;
    comments: string | null;
    downloadUrl: string | null;
}

export interface ParsedEmailInfo {
    // флаг, что это реально MiFILE/TrueFiling письмо
    isMiFile: boolean;

    // общие поля
    courtName: string | null;
    caseNumber: string | null;
    temporaryCaseNumber?: string | null;
    newCaseNumber?: string | null;
    caseTitle: string | null;
    plaintiff: string | null;
    defendant: string | null;
    bundleNumber: string | null;
    filerName: string | null;
    submitterName?: string | null;
    filedAt: string | null;            // либо Date and Time Filed / Submitted / Sent

    // документы
    filedDocuments: FiledDocumentInfo[];

    // техническое
    fileTypeByAttachmentId: Record<string, string>;
}

export interface CourtEmailAttachment {
    id: string;
    name: string;
    contentType: string | null;
    size: number;
    isInline: boolean;
}

export interface CourtEmailLookup {
    subject: string | null;
    sender: string | null;
    receivedAt: string | null;
}

const tenantId = process.env.TENANT_ID!;
const clientId = process.env.CLIENT_ID!;
const clientSecret = process.env.CLIENT_SECRET!;
const userEmail = process.env.USER_EMAIL!;

if (!tenantId || !clientId || !clientSecret || !userEmail) {
    throw new Error('Missing TENANT_ID / CLIENT_ID / CLIENT_SECRET / USER_EMAIL in .env');
}

const credential = new ClientSecretCredential(tenantId, clientId, clientSecret);

const graphClient = Client.initWithMiddleware({
    authProvider: {
        getAccessToken: async () => {
            const token = await credential.getToken('https://graph.microsoft.com/.default');
            if (!token) throw new Error('Failed to get Graph access token');
            return token.token;
        },
    },
});

// ===== FETCH EMAILS =====

function boundedEnvironmentInteger(
    value: string | undefined,
    fallback: number,
    min: number,
    max: number,
): number {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) return fallback;
    return Math.min(Math.max(Math.floor(parsed), min), max);
}

const GRAPH_INBOX_PAGE_SIZE = boundedEnvironmentInteger(
    process.env.GRAPH_INBOX_PAGE_SIZE,
    10,
    5,
    50,
);
const GRAPH_REQUEST_MAX_ATTEMPTS = boundedEnvironmentInteger(
    process.env.GRAPH_REQUEST_MAX_ATTEMPTS,
    5,
    1,
    10,
);
const GRAPH_BODY_FETCH_CONCURRENCY = boundedEnvironmentInteger(
    process.env.GRAPH_BODY_FETCH_CONCURRENCY,
    4,
    1,
    10,
);

function graphRetryOptions(label: string) {
    return {
        label,
        maxAttempts: GRAPH_REQUEST_MAX_ATTEMPTS,
        onRetry: (details: {
            attempt: number;
            maxAttempts: number;
            delayMs: number;
            reason: string;
        }) => {
            console.warn(
                `${label} failed; retrying after ${details.delayMs}ms ` +
                `(attempt ${details.attempt + 1}/${details.maxAttempts}): ${details.reason}`,
            );
        },
    };
}

export async function fetchRecentCourtEmailHeaders(top: number): Promise<any[]> {
    const limit = Math.min(Math.max(Math.floor(top), 1), 1_000);
    const pageSize = Math.min(limit, GRAPH_INBOX_PAGE_SIZE);
    const firstPath =
        `/users/${encodeURIComponent(userEmail)}/mailFolders/Inbox/messages`;

    const firstPage = await withGraphRetry(
        () => graphClient
            .api(firstPath)
            .header('Accept-Encoding', 'identity')
            .top(pageSize)
            .orderby('receivedDateTime DESC')
            .select('id,subject,from,receivedDateTime')
            .get(),
        graphRetryOptions('Graph Inbox metadata page 1'),
    );

    const messages = [...(firstPage.value ?? [])] as any[];
    let nextLink = firstPage['@odata.nextLink'] as string | undefined;
    let pageNumber = 2;

    while (nextLink && messages.length < limit) {
        try {
            const page = await withGraphRetry(
                () => graphClient
                    .api(nextLink!)
                    .header('Accept-Encoding', 'identity')
                    .get(),
                graphRetryOptions(`Graph Inbox metadata page ${pageNumber}`),
            );
            messages.push(...((page.value ?? []) as any[]));
            nextLink = page['@odata.nextLink'] as string | undefined;
            pageNumber += 1;
        } catch (error) {
            console.error(
                `Graph Inbox page ${pageNumber} exhausted retries; ` +
                `continuing with ${messages.length} message(s): ${graphErrorReason(error)}`,
            );
            break;
        }
    }

    return messages.slice(0, limit);
}

export async function fetchRecentCourtEmails(top: number): Promise<any[]> {
    const headers = await fetchRecentCourtEmailHeaders(top);
    const messages: any[] = [];

    for (let offset = 0; offset < headers.length; offset += GRAPH_BODY_FETCH_CONCURRENCY) {
        const batch = headers.slice(offset, offset + GRAPH_BODY_FETCH_CONCURRENCY);
        const results = await Promise.allSettled(
            batch.map(header => fetchCourtEmailById(String(header.id))),
        );
        results.forEach((result, index) => {
            if (result.status === 'fulfilled') {
                messages.push(result.value);
            } else {
                console.error(
                    `Skipping Inbox message ${batch[index]?.id || 'unknown'} for this pass ` +
                    `after body-fetch retries: ${graphErrorReason(result.reason)}`,
                );
            }
        });
    }

    return messages;
}

export async function fetchCourtEmailById(messageId: string): Promise<any> {
    return withGraphRetry(
        () => graphClient
                .api(`/users/${encodeURIComponent(userEmail)}/messages/${encodeURIComponent(messageId)}`)
                .header('Accept-Encoding', 'identity')
                .select('id,subject,from,body,receivedDateTime')
                .get(),
        graphRetryOptions(`Graph message ${messageId}`),
    );
}

// ===== PARSER (универсальный) =====

export function sanitizeGraphSearchSubject(subject: string): string {
    return subject
        .replace(/["\\&?#%+]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

export async function findCourtEmailByMetadata(lookup: CourtEmailLookup): Promise<any | null> {
    const receivedAt = lookup.receivedAt ? new Date(lookup.receivedAt) : null;
    if (!receivedAt || Number.isNaN(receivedAt.getTime()) || !lookup.subject?.trim()) {
        return null;
    }

    const path = `/users/${encodeURIComponent(userEmail)}/messages`;
    const searchSubject = sanitizeGraphSearchSubject(lookup.subject);
    let messages: any[] = [];
    try {
        const searchResult = await withGraphRetry(
            () => graphClient
                .api(path)
                .header('Accept-Encoding', 'identity')
                .header('ConsistencyLevel', 'eventual')
                .search(`"subject:${searchSubject}"`)
                .top(100)
                .select('id,subject,from,receivedDateTime')
                .get(),
            graphRetryOptions(`Graph subject recovery search for ${lookup.subject}`),
        );
        messages = (searchResult.value ?? []) as any[];
    } catch (error) {
        console.warn('Graph subject recovery search failed; falling back to a date window:', error);
    }

    if (!messages.length) {
        const windowMs = 2 * 60 * 60 * 1000;
        const from = new Date(receivedAt.getTime() - windowMs).toISOString();
        const to = new Date(receivedAt.getTime() + windowMs).toISOString();
        const dateResult = await withGraphRetry(
            () => graphClient
                .api(path)
                .header('Accept-Encoding', 'identity')
                .filter(`receivedDateTime ge ${from} and receivedDateTime le ${to}`)
                .top(100)
                .select('id,subject,from,receivedDateTime')
                .get(),
            graphRetryOptions(`Graph date recovery search for ${lookup.subject}`),
        );
        messages = (dateResult.value ?? []) as any[];
    }

    const normalizedSubject = lookup.subject.trim().toLowerCase();
    const normalizedSender = lookup.sender?.trim().toLowerCase() ?? '';
    const candidates = messages
        .filter(message => String(message.subject ?? '').trim().toLowerCase() === normalizedSubject)
        .map(message => {
            const sender = String(message.from?.emailAddress?.address ?? '').trim().toLowerCase();
            const senderMatches = !normalizedSender || sender === normalizedSender;
            const distance = Math.abs(
                new Date(message.receivedDateTime ?? 0).getTime() - receivedAt.getTime(),
            );
            return { message, senderMatches, distance };
        })
        .sort((left, right) =>
            Number(right.senderMatches) - Number(left.senderMatches) ||
            left.distance - right.distance,
        );

    const best = candidates[0]?.message;
    if (!best) return null;

    console.log('Recovered Outlook message by metadata:', {
        subject: lookup.subject,
        receivedAt: lookup.receivedAt,
        messageId: best.id,
    });
    return fetchCourtEmailById(String(best.id));
}

export async function fetchCourtEmailPdfAttachments(
    messageId: string,
): Promise<CourtEmailAttachment[]> {
    const result = await withGraphRetry(
        () => graphClient
            .api(`/users/${encodeURIComponent(userEmail)}/messages/${encodeURIComponent(messageId)}/attachments`)
            .header('Accept-Encoding', 'identity')
            .top(100)
            .select('id,name,contentType,size,isInline')
            .get(),
        graphRetryOptions(`Graph PDF attachment list for ${messageId}`),
    );

    return ((result.value ?? []) as any[])
        .filter(attachment => {
            if (attachment.isInline) return false;
            const contentType = String(attachment.contentType ?? '').toLowerCase();
            const name = String(attachment.name ?? '').toLowerCase();
            return contentType === 'application/pdf' || name.endsWith('.pdf');
        })
        .map(attachment => ({
            id: String(attachment.id),
            name: String(attachment.name || 'attachment.pdf'),
            contentType: attachment.contentType ? String(attachment.contentType) : null,
            size: Number(attachment.size ?? 0),
            isInline: Boolean(attachment.isInline),
        }));
}

export async function downloadCourtEmailAttachment(
    messageId: string,
    attachmentId: string,
): Promise<Buffer> {
    const value = await withGraphRetry(
        () => graphClient
            .api(
                `/users/${encodeURIComponent(userEmail)}/messages/${encodeURIComponent(messageId)}` +
                `/attachments/${encodeURIComponent(attachmentId)}/$value`,
            )
            .header('Accept-Encoding', 'identity')
            .responseType(ResponseType.ARRAYBUFFER)
            .get(),
        graphRetryOptions(`Graph PDF attachment ${attachmentId}`),
    );

    if (Buffer.isBuffer(value)) return value;
    if (value instanceof ArrayBuffer) return Buffer.from(value);
    if (ArrayBuffer.isView(value)) {
        return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
    }
    throw new Error('Microsoft Graph returned an unsupported attachment payload');
}

export function parseEmailBody(bodyHtml: string): ParsedEmailInfo {
    const text = htmlToText(bodyHtml);

    // Type B: single‑document (“Your document was successfully filed…”)
    const bLike = parseSingleDocumentStyle(text, bodyHtml);
    if (bLike) {
        return { ...bLike, isMiFile: true };
    }

    // Type A: multi‑document (таблица Court Name / Temporary Case Number / ... + Document Type / Status / Comments / Stamped Copy)
    const aLike = parseMultiDocumentStyle(text, bodyHtml);
    if (aLike) {
        return { ...aLike, isMiFile: true };
    }

    // Type C: “Document Sent …” от TrueFiling (нет суда/кейса, только один документ)
    const cLike = parseDocumentSentStyle(text, bodyHtml);
    if (cLike) {
        return { ...cLike, isMiFile: true };
    }

    // не похоже на MiFILE/TrueFiling → пустая структура
    return {
        isMiFile: false,
        courtName: null,
        caseNumber: null,
        caseTitle: null,
        plaintiff: null,
        defendant: null,
        bundleNumber: null,
        filerName: null,
        submitterName: null,
        temporaryCaseNumber: null,
        newCaseNumber: null,
        filedAt: null,
        filedDocuments: [],
        fileTypeByAttachmentId: {},
    };
}

// ===== PARSER: Type B single‑document (“Your document was successfully filed…”) =====

function parseSingleDocumentStyle(
    text: string,
    html: string,
): Omit<ParsedEmailInfo, 'isMiFile'> | null {
    const marker = 'Your document was successfully filed with the ';
    const idx = text.indexOf(marker);
    if (idx === -1) return null;

    const courtName = extractCourtNameFromSuccessLine(text);

    const caseLine = extractAfterLabel(text, 'Case Number:');
    const { caseNumber, caseTitle, plaintiff, defendant } = splitCaseLine(caseLine);

    const documentName = extractAfterLabel(text, 'Document Name:');
    const documentType = extractAfterLabel(text, 'Document Type:');
    const bundleNumber = extractAfterLabel(text, 'Bundle ID Number:') ??
        extractAfterLabel(text, 'Bundle Number:');
    const filerName = extractAfterLabel(text, 'Filer Name:');
    const filedAt = extractAfterLabel(text, 'Date and Time Filed:');

    const comments = (() => {
        const c = extractAfterLabel(text, 'Comments:');
        if (!c) return null;
        return c;
    })();

    const downloadUrl = extractDownloadUrl(html);

    const filedDocuments: FiledDocumentInfo[] = [
        {
            documentName: clean(documentName),
            documentType: clean(documentType),
            status: 'Filed',
            comments: clean(comments),
            downloadUrl,
        },
    ];

    return {
        courtName: clean(courtName),
        caseNumber: clean(caseNumber),
        caseTitle: clean(caseTitle),
        plaintiff: clean(plaintiff),
        defendant: clean(defendant),
        bundleNumber: clean(bundleNumber),
        filerName: clean(filerName),
        submitterName: null,
        temporaryCaseNumber: null,
        newCaseNumber: null,
        filedAt: clean(filedAt),
        filedDocuments,
        fileTypeByAttachmentId: {},
    };
}

// ===== PARSER: Type A multi‑document (таблица Document Type / Status / Comments / Stamped Copy) =====

function parseMultiDocumentStyle(
    text: string,
    html: string,
): Omit<ParsedEmailInfo, 'isMiFile'> | null {
    const headerRegex =
        /Court Name:\s*(?<courtName>.+?)\s+Temporary Case Number:\s*(?<temporaryCaseNumber>.+?)\s+New Case Number:\s*(?<newCaseNumber>.+?)\s+Case Title:\s*(?<caseTitle>.+?)\s+Bundle Number:\s*(?<bundleNumber>.+?)\s+Filer Name:\s*(?<filerName>.+?)\s+Submitter Name:\s*(?<submitterName>.+?)\s+Date and Time Submitted:\s*(?<submittedAt>.+?)\s/i;

    const headerMatch = headerRegex.exec(text);
    if (!headerMatch || !headerMatch.groups) return null;

    const h = headerMatch.groups;

    const docsBlockMatch =
        /Document Type\s+Status\s+Comments\s+Stamped Copy([\s\S]+)/i.exec(text);
    const docsBlock = docsBlockMatch?.[1] ?? '';

    // все ссылки на filestampedcopy из HTML (в порядке появления)
    const allUrls = extractAllDownloadUrlsFromHtml(html);
    let urlIndex = 0;

    const docLineRegex =
        /([^\n]+?)\s+Filed\s+This document has been officially filed with the court\.\s*\((\d+)\)/gi;

    const filedDocuments: FiledDocumentInfo[] = [];
    let m: RegExpExecArray | null;

    while ((m = docLineRegex.exec(docsBlock)) !== null) {
        const documentTypeRaw = m[1];
        const code = m[2];

        const url = urlIndex < allUrls.length ? allUrls[urlIndex] : null;
        urlIndex++;

        filedDocuments.push({
            documentType: clean(documentTypeRaw),
            status: 'Filed',
            comments: `This document has been officially filed with the court. (${code})`,
            downloadUrl: url,
        });
    }

    const caseLine =
        extractAfterLabel(text, 'New Case Number:') ??
        extractAfterLabel(text, 'Temporary Case Number:');
    const parsedCase = splitCaseLine(caseLine);

    return {
        courtName: clean(h.courtName),
        caseNumber: clean(parsedCase.caseNumber),
        caseTitle: clean(h.caseTitle),
        plaintiff: clean(parsedCase.plaintiff),
        defendant: clean(parsedCase.defendant),
        bundleNumber: clean(h.bundleNumber),
        filerName: clean(h.filerName),
        submitterName: clean(h.submitterName),
        temporaryCaseNumber: clean(h.temporaryCaseNumber),
        newCaseNumber: clean(h.newCaseNumber),
        filedAt: clean(h.submittedAt),
        filedDocuments,
        fileTypeByAttachmentId: {},
    };
}

// ===== PARSER: Type C “Document Sent …” (TrueFiling e‑service) =====

export function isUsableTrueCertifyUrl(value: string | null | undefined): boolean {
    if (!value) return false;
    try {
        const url = new URL(value.replace(/&amp;/gi, '&'));
        if (url.hostname.toLowerCase() !== 'eservices.truecertify.com') return false;
        const parameters = new Map<string, string>();
        url.searchParams.forEach((parameterValue, key) => {
            parameters.set(key.toLowerCase(), parameterValue.trim());
        });
        return !!parameters.get('loc') && !!parameters.get('key');
    } catch {
        return false;
    }
}

function trueCertifyDownloadUrl(html: string, text: string): string | null {
    const candidates = `${html}\n${text}`.match(
        /https:\/\/eservices\.truecertify\.com\/[^\s"'<>]*/gi,
    ) ?? [];
    for (const candidate of candidates) {
        const normalized = candidate.replace(/&amp;/gi, '&').replace(/[),.;]+$/, '');
        if (isUsableTrueCertifyUrl(normalized)) return normalized;
    }
    return null;
}

function parseDocumentSentStyle(
    text: string,
    html: string,
): Omit<ParsedEmailInfo, 'isMiFile'> | null {
    // 1) Главный маркер Type C — ссылка на TrueCertify
    const downloadUrl = trueCertifyDownloadUrl(html, text);
    const isDocumentSentNotice =
        /MiFILE\s*-\s*Document Sent/i.test(text) ||
        /document was electronically sent on behalf of the\s+.+?COURT\s+by MiFILE/i.test(text);

    if (!downloadUrl && !isDocumentSentNotice) {
        // нет TrueCertify‑ссылки → точно не Type C
        return null;
    }

    // 2) Остальные поля — best effort
    const documentName = extractAfterLabel(text, 'Document Name:');
    const documentType = extractAfterLabel(text, 'Document Type:');

    // courtName:
    // "The following document was electronically sent on behalf of the 48TH DISTRICT COURT by MiFILE."
    let courtName: string | null = null;
    const courtMatch = text.match(
        /The following document was electronically sent on behalf of the\s+(.+?COURT)\s+by MiFILE/i
    );
    if (courtMatch) {
        courtName = courtMatch[1]?.trim() || null;
    }

    // caseNumber / caseTitle из:
    // "MiFILE - Document Sent 25-08823-LT, CAPITOL VILLAGE V CHAN"
    let caseNumber: string | null = null;
    let caseTitle: string | null = null;

    const docSentMatch = text.match(/MiFILE\s*-\s*Document Sent\s+([^\n,]+),\s*(.+)\s*$/mi);
    if (docSentMatch) {
        caseNumber = docSentMatch[1]?.trim() || null;
        caseTitle = docSentMatch[2]?.trim() || null;
    }

    const filedDocuments: FiledDocumentInfo[] = [
        {
            documentName: clean(documentName) ?? 'ORDER',
            documentType: clean(documentType) ?? 'OTHER',
            status: 'Sent',
            comments: null,
            downloadUrl,
        },
    ];

    return {
        courtName: clean(courtName),
        caseNumber: clean(caseNumber),
        caseTitle: clean(caseTitle),
        plaintiff: null,
        defendant: null,
        bundleNumber: null,
        filerName: null,
        submitterName: null,
        temporaryCaseNumber: null,
        newCaseNumber: null,
        filedAt: null,
        filedDocuments,
        fileTypeByAttachmentId: {},
    };
}

// ===== HELPERS =====

function htmlToText(html: string): string {
    if (!html) return '';
    let text = html;

    text = text.replace(/&nbsp;/gi, ' ');
    text = text.replace(/&amp;/gi, '&');
    text = text.replace(/&lt;/gi, '<');
    text = text.replace(/&gt;/gi, '>');
    text = text.replace(/&quot;/gi, '"');
    text = text.replace(/&#39;/gi, "'");

    text = text.replace(/<br\s*\/?>/gi, '\n');
    text = text.replace(/<\/p>/gi, '\n');
    text = text.replace(/<\/tr>/gi, '\n');
    text = text.replace(/<[^>]+>/g, ' ');

    text = text.replace(/\r/g, '\n');
    text = text.replace(/\n{2,}/g, '\n');
    text = text.replace(/[ \t]{2,}/g, ' ');
    return text.trim();
}

function clean(s: string | null | undefined): string | null {
    if (!s) return null;
    const t = s.trim();
    return t.length ? t : null;
}

function extractAfterLabel(text: string, label: string): string | null {
    const idx = text.indexOf(label);
    if (idx === -1) return null;

    let after = text.slice(idx + label.length);
    after = after.replace(/^[:\s]+/, '');

    const match = after.match(/^(.*?)(\n{1,}|\r{1,}| {2,}|$)/s);
    const value = match ? match[1] : after;
    return value.trim();
}

function extractCourtNameFromSuccessLine(text: string): string | null {
    const marker = 'Your document was successfully filed with the ';
    const idx = text.indexOf(marker);
    if (idx === -1) return null;
    const after = text.slice(idx + marker.length);
    const endIdx = after.indexOf('.');
    const value = (endIdx === -1 ? after : after.slice(0, endIdx)).trim();
    return value || null;
}

function splitCaseLine(caseLine: string | null): {
    caseNumber: string | null;
    caseTitle: string | null;
    plaintiff: string | null;
    defendant: string | null;
} {
    if (!caseLine) {
        return { caseNumber: null, caseTitle: null, plaintiff: null, defendant: null };
    }

    const firstComma = caseLine.indexOf(',');
    let caseNumber: string | null = null;
    let caseTitle: string | null = null;

    if (firstComma === -1) {
        caseNumber = caseLine.trim();
    } else {
        caseNumber = caseLine.slice(0, firstComma).trim();
        caseTitle = caseLine.slice(firstComma + 1).trim();
    }

    let plaintiff: string | null = null;
    let defendant: string | null = null;

    if (caseTitle) {
        const vIdx = caseTitle.toUpperCase().indexOf(' V ');
        if (vIdx !== -1) {
            plaintiff = caseTitle.slice(0, vIdx).trim();
            defendant = caseTitle.slice(vIdx + 3).trim();
        }
    }

    return {
        caseNumber: caseNumber || null,
        caseTitle: caseTitle || null,
        plaintiff: plaintiff || null,
        defendant: defendant || null,
    };
}

function extractDownloadUrl(html: string): string | null {
    if (!html) return null;

    const hrefMatch = html.match(
        /https:\/\/mifile\.courts\.michigan\.gov\/[^\s"'<>]*filestampedcopy[^\s"'<>]*/i
    );
    if (hrefMatch) {
        return hrefMatch[0];
    }

    return null;
}

// ссылки для multi‑file из HTML (MiFILE stamped copies)
function extractAllDownloadUrlsFromHtml(html: string): string[] {
    if (!html) return [];

    const urls: string[] = [];
    const regex = /https:\/\/mifile\.courts\.michigan\.gov\/[^\s"'<>]*filestampedcopy[^\s"'<>]*/gi;

    let m: RegExpExecArray | null;
    while ((m = regex.exec(html)) !== null) {
        urls.push(m[0]);
    }

    return urls;
}
