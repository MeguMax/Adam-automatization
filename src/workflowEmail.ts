import { fetchCourtEmailAttachments, parseEmailBody, ParsedEmailInfo } from './emailProcessor';
import { addEmailAttachmentSources } from './emailAttachmentSource';
import { buildFilingIntake, hasNamedFilingPackage, intakeSenderAllowed, isFilingIntakeSubject } from './filingIntake';
import { isProcessingReportSubject } from './processingReport';

export function isCourtNotificationMessage(message: any): boolean {
    const sender = String(message.from?.emailAddress?.address || '').trim().toLowerCase();
    return /^[^@\s]+@truefiling\.com$/.test(sender) &&
        !/^\s*(?:re|fw|fwd)\s*:/i.test(String(message.subject || ''));
}

export async function parseWorkflowEmail(message: any, fetchAttachments = fetchCourtEmailAttachments): Promise<ParsedEmailInfo | null> {
    if (isProcessingReportSubject(message.subject)) return null;
    if (isFilingIntakeSubject(message.subject) || (intakeSenderAllowed(message) &&
        !/^\s*(?:re|fw|fwd)\s*:/i.test(String(message.subject || '')) &&
        !/mifile\s*-\s*(?:document (?:filed|sent)|case created)/i.test(String(message.subject || '')) && message.hasAttachments !== false)) {
        if (!intakeSenderAllowed(message)) return null;
        const notice = addEmailAttachmentSources(parseEmailBody(message.body?.content || '', message.subject || ''));
        if (notice.isMiFile) return notice;
        const attachments = await fetchAttachments(String(message.id));
        if (!isFilingIntakeSubject(message.subject) && !hasNamedFilingPackage(attachments)) return null;
        return buildFilingIntake(message, attachments);
    }
    if (!isCourtNotificationMessage(message)) return null;
    const parsed = addEmailAttachmentSources(parseEmailBody(message.body?.content || '', message.subject || ''));
    return parsed.isMiFile ? parsed : null;
}
