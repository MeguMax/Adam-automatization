import type { ParsedEmailInfo } from './emailProcessor';

const EMAIL_ATTACHMENT_SOURCE_PREFIX = 'email-attachment://';

export function createEmailAttachmentSource(fileName: string, attachmentId?: string): string {
    return `${EMAIL_ATTACHMENT_SOURCE_PREFIX}${encodeURIComponent(fileName.trim())}` +
        (attachmentId ? `?id=${encodeURIComponent(attachmentId)}` : '');
}

export function isEmailAttachmentSource(value: string | null | undefined): boolean {
    return !!value && value.startsWith(EMAIL_ATTACHMENT_SOURCE_PREFIX);
}

export function emailAttachmentSourceName(value: string | null | undefined): string | null {
    if (!isEmailAttachmentSource(value)) return null;
    try {
        return decodeURIComponent(value!.slice(EMAIL_ATTACHMENT_SOURCE_PREFIX.length).split('?')[0]) || null;
    } catch {
        return null;
    }
}

export function emailAttachmentSourceId(value: string | null | undefined): string | null {
    if (!isEmailAttachmentSource(value)) return null;
    const query = value!.indexOf('?');
    return query < 0 ? null : new URLSearchParams(value!.slice(query + 1)).get('id');
}

export function addEmailAttachmentSources(parsed: ParsedEmailInfo): ParsedEmailInfo {
    return {
        ...parsed,
        filedDocuments: parsed.filedDocuments.map(document => {
            if (document.downloadUrl || document.status?.toLowerCase() !== 'sent') {
                return document;
            }
            return {
                ...document,
                downloadUrl: createEmailAttachmentSource(
                    document.documentName || document.documentType || 'attachment.pdf',
                ),
            };
        }),
    };
}
