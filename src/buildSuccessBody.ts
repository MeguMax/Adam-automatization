// buildSuccessBody.ts
import { NotificationFile } from './downloadFiledDocuments';
import { ParsedEmailInfo } from './emailProcessor';

export function buildSuccessBody(args: {
    msg: any;                  // раньше Message
    parsed: ParsedEmailInfo;
    files: NotificationFile[];
}) {
    const { msg, parsed, files } = args;

    const header =
        `Original email:\n` +
        `Subject: ${msg.subject}\n` +
        `From: ${msg.from?.emailAddress?.address}\n` +
        `Received: ${msg.receivedDateTime}\n\n` +
        `Case:\n` +
        `Court: ${parsed.courtName ?? 'N/A'}\n` +
        `Case: ${parsed.caseNumber ?? 'N/A'}\n` +
        `Title: ${parsed.caseTitle ?? 'N/A'}\n\n` +
        `Documents:\n`;

    const docs = files
        .map(
            f =>
                `- ${f.displayName || f.fileName}\n` +
                (f.webUrl ? `  OneDrive: ${f.webUrl}\n` : ''),
        )
        .join('\n');

    return header + docs;
}

export function buildErrorBody(args: {
    msg: any;                  // раньше Message
    parsed?: ParsedEmailInfo;
    error: unknown;
}) {
    const { msg, parsed, error } = args;

    return (
        `Failed to process court email.\n\n` +
        `Original subject: ${msg.subject}\n` +
        `From: ${msg.from?.emailAddress?.address}\n` +
        `Received: ${msg.receivedDateTime}\n\n` +
        (parsed
            ? `Parsed case: ${parsed.caseNumber ?? 'N/A'} – ${parsed.caseTitle ?? 'N/A'}\n\n`
            : '') +
        `Error: ${String(error)}\n\n` +
        `Action: Please download documents manually from the original email.`
    );
}
