import { fetchCourtEmailAttachments, parseEmailBody, ParsedEmailInfo } from './emailProcessor';
import { addEmailAttachmentSources } from './emailAttachmentSource';
import { buildFilingIntake, intakeSenderAllowed, isFilingIntakeSubject } from './filingIntake';
import { isProcessingReportSubject } from './processingReport';

export function isCourtNotificationMessage(message: any): boolean {
    const sender = String(message.from?.emailAddress?.address || '').trim().toLowerCase();
    return /^[^@\s]+@truefiling\.com$/.test(sender) &&
        !/^\s*(?:re|fw|fwd)\s*:/i.test(String(message.subject || ''));
}

export async function parseWorkflowEmail(message: any): Promise<ParsedEmailInfo | null> {
    if (isProcessingReportSubject(message.subject)) return null;
    if (isFilingIntakeSubject(message.subject)) {
        if (!intakeSenderAllowed(message)) return null;
        const notice = addEmailAttachmentSources(parseEmailBody(message.body?.content || '', message.subject || ''));
        if (notice.isMiFile) return notice;
        return buildFilingIntake(message, await fetchCourtEmailAttachments(String(message.id)));
    }
    if (!isCourtNotificationMessage(message)) return null;
    const parsed = addEmailAttachmentSources(parseEmailBody(message.body?.content || '', message.subject || ''));
    return parsed.isMiFile ? parsed : null;
}
