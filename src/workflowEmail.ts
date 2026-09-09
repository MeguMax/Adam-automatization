import { fetchCourtEmailAttachments, parseEmailBody, ParsedEmailInfo } from './emailProcessor';
import { addEmailAttachmentSources } from './emailAttachmentSource';
import { buildFilingIntake, intakeSenderAllowed, isFilingIntakeSubject } from './filingIntake';

export async function parseWorkflowEmail(message: any): Promise<ParsedEmailInfo | null> {
    if (isFilingIntakeSubject(message.subject)) {
        if (!intakeSenderAllowed(message)) return null;
        const notice = addEmailAttachmentSources(parseEmailBody(message.body?.content || ''));
        if (notice.isMiFile) return notice;
        return buildFilingIntake(message, await fetchCourtEmailAttachments(String(message.id)));
    }
    const parsed = addEmailAttachmentSources(parseEmailBody(message.body?.content || ''));
    return parsed.isMiFile ? parsed : null;
}
