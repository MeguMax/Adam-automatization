import { createHash } from 'node:crypto';
import type { CourtEmailAttachment, ParsedEmailInfo } from './emailProcessor';
import { createEmailAttachmentSource } from './emailAttachmentSource';

export const INTAKE_SUBJECT_PREFIX = 'NEW LT FILING';
export const INTAKE_MAX_PDF_BYTES = 25 * 1024 * 1024;

export interface FilingIntakeInfo {
    manual?: boolean;
    packageMode?: 'standard_lt' | 'custom';
    storageKey: string;
    issues: string[];
    packageKey?: string;
    packageLabel?: string;
    batchSize?: number;
    groups?: Array<{ key: string; label: string; sources: string[]; issues: string[] }>;
}

export function intakeCasePrefix(filename: string): { key: string; label: string } | null {
    const match = filename.normalize('NFKC').trim().match(
        /^(.+?)\s+([a-z])\s+(?:complaint|summons|request|demand|other|connected|notice|lease|deed|advice|local|affidavit)\b.*\.pdf$/i,
    );
    if (!match || !/[a-z\p{L}]/iu.test(match[1])) return null;
    const surname = match[1].replace(/\s+/g, ' ').trim();
    return { key: `${surname.toLowerCase()} ${match[2].toLowerCase()}`, label: `${surname} ${match[2].toUpperCase()}` };
}

export function hasNamedFilingPackage(attachments: CourtEmailAttachment[]): boolean {
    return attachments.some(file => isPdfAttachment(file) && intakeCasePrefix(file.name) &&
        /\bcomplaint\b/i.test(file.name));
}

export function splitFilingIntake(parsed: ParsedEmailInfo): ParsedEmailInfo[] {
    if (!parsed.intake?.groups?.length) return [parsed];
    const { groups, ...intake } = parsed.intake;
    return groups.map(group => ({ ...parsed, intake: {
        ...intake, packageKey: group.key, packageLabel: group.label, batchSize: groups.length,
        storageKey: createHash('sha256').update(`${intake.storageKey}\n${group.key}`).digest('hex').slice(0, 24),
        issues: [...intake.issues.filter(issue => !issue.startsWith('Duplicate attachment filename:')), ...group.issues],
    }, filedDocuments: parsed.filedDocuments.filter(document => group.sources.includes(document.downloadUrl || '')) }));
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
    const groups = new Map<string, { key: string; label: string; sources: string[]; issues: string[] }>();
    const named = pdfs.some(file => intakeCasePrefix(file.name));
    for (const file of named ? pdfs : []) {
        const prefix = intakeCasePrefix(file.name);
        const key = prefix?.key || '__unassigned__';
        const group = groups.get(key) || { key, label: prefix?.label || 'Unassigned attachments', sources: [], issues: [] };
        group.sources.push(createEmailAttachmentSource(file.name, file.id));
        if (!prefix) group.issues.push(`Cannot assign ${file.name} to a case. Use [Last Name] [First Initial] [File Type].pdf or move it to the correct Draft.`);
        groups.set(key, group);
    }
    if (groups.size > 1) for (const group of groups.values()) {
        const groupFiles = pdfs.filter(file => group.sources.includes(createEmailAttachmentSource(file.name, file.id)));
        const seen = new Set<string>();
        for (const file of groupFiles) {
            const name = file.name.trim().toLowerCase();
            if (seen.has(name)) group.issues.push(`Duplicate attachment filename: ${file.name}. Review both documents.`);
            seen.add(name);
        }
        if (group.key !== '__unassigned__' && groupFiles.length && groupFiles.every(file =>
            /\b(?:demand|other|connected|notice|lease|deed|affidavit)\b/i.test(file.name))) {
            group.issues.push(`Supporting PDFs for ${group.label} have no matching Complaint prefix in this email. Check the filename and move the PDF only after confirming its case.`);
            group.label = `Unmatched supporting files - ${group.label}`;
        }
    }
    return {
        isMiFile: false,
        sourceKind: 'new_filing_intake',
        intake: {
            storageKey: createHash('sha256').update(String(message.internetMessageId || message.id))
                .digest('hex').slice(0, 24),
            issues,
            ...(groups.size > 1 ? { groups: [...groups.values()].sort((a, b) => a.key.localeCompare(b.key)) } : {}),
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
            // A real PDF attachment is not a notification's virtual, linkless fee item.
            documentType: /\b(?:mailing|filing) fee\b/i.test(attachment.name.replace(/[_-]+/g,' ')) ? 'Other' :
                attachment.name.replace(/\.pdf$/i, '').replace(/[_-]+/g, ' '),
            status: 'Received',
            comments: null,
            downloadUrl: createEmailAttachmentSource(attachment.name, attachment.id),
        })),
        fileTypeByAttachmentId: {},
    };
}
