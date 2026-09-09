import { createHash } from 'node:crypto';
import type { CourtEmailAttachment, ParsedEmailInfo } from './emailProcessor';
import { createEmailAttachmentSource } from './emailAttachmentSource';

export const INTAKE_SUBJECT_PREFIX = 'NEW LT FILING';
export const INTAKE_MAX_PDF_BYTES = 25 * 1024 * 1024;

export interface FilingIntakeInfo {
    storageKey: string;
    issues: string[];
}

export function isFilingIntakeSubject(subject: unknown): boolean {
    return /^NEW LT FILING(?:\s*-\s*|\s*$)/i.test(String(subject || '').trim());
}

export function getFilingIntakeConfig(environment: NodeJS.ProcessEnv = process.env) {
    const allowedSenders = [...new Set((environment.FILING_INTAKE_ALLOWED_SENDERS ??
        `ajd@devlinlawpllc.com,${environment.USER_EMAIL || ''}`)
        .split(/[,;\n]/).map(value => value.trim().toLowerCase()).filter(Boolean))];
    return {
        mailbox: environment.USER_EMAIL || '',
        subjectPrefix: INTAKE_SUBJECT_PREFIX,
        allowedSenders,
        maxPdfBytes: INTAKE_MAX_PDF_BYTES,
        preparationMode: 'unsubmitted_only' as const,
    };
}

export function intakeSenderAllowed(message: any, environment: NodeJS.ProcessEnv = process.env): boolean {
    const sender = String(message.from?.emailAddress?.address || '').trim().toLowerCase();
    return getFilingIntakeConfig(environment).allowedSenders.includes(sender);
}

export function isPdfAttachment(attachment: CourtEmailAttachment): boolean {
    return !attachment.isInline && (attachment.contentType?.toLowerCase() === 'application/pdf' ||
        /\.pdf$/i.test(attachment.name));
}

export function intakeFileName(name: string, source: string): string {
    const stem = name.replace(/\.pdf$/i, '').replace(/[<>:"/\\|?*\x00-\x1f#%]/g, '_')
        .replace(/[. ]+$/g, '').trim().slice(0, 140) || 'Document';
    const suffix = createHash('sha256').update(source).digest('hex').slice(0, 12);
    return `${stem}-${suffix}.pdf`;
}

export function buildFilingIntake(
    message: any,
    attachments: CourtEmailAttachment[],
): ParsedEmailInfo {
    const files = attachments.filter(attachment => !attachment.isInline);
    const pdfs = files.filter(isPdfAttachment);
    const issues = files.filter(attachment => !isPdfAttachment(attachment))
        .map(attachment => `Unsupported attachment: ${attachment.name}. Attach documents as individual PDFs.`);
    if (!pdfs.length) issues.push('No PDF attachments were received. Add the case documents in the Draft editor.');
    const names = new Set<string>();
    for (const pdf of pdfs) {
        const name = pdf.name.trim().toLowerCase();
        if (names.has(name)) issues.push(`Duplicate attachment filename: ${pdf.name}. Review both documents.`);
        names.add(name);
    }
    return {
        isMiFile: false,
        sourceKind: 'new_filing_intake',
        intake: {
            storageKey: createHash('sha256').update(String(message.internetMessageId || message.id))
                .digest('hex').slice(0, 24),
            issues,
        },
        courtName: null,
        caseNumber: null,
        caseTitle: null,
        plaintiff: null,
        defendant: null,
        bundleNumber: null,
        filerName: 'Devlin, Adam',
        filedAt: null,
        filedDocuments: pdfs.map(attachment => ({
            documentName: attachment.name,
            documentType: attachment.name.replace(/\.pdf$/i, '').replace(/[_-]+/g, ' '),
            status: 'Received',
            comments: null,
            downloadUrl: createEmailAttachmentSource(attachment.name, attachment.id),
        })),
        fileTypeByAttachmentId: {},
    };
}
