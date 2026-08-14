// buildSuccessBody.ts
import { NotificationFile } from './downloadFiledDocuments';
import { ParsedEmailInfo } from './emailProcessor';

export function buildSuccessBody(args: {
    msg: any;                  // раньше Message
    parsed: ParsedEmailInfo;
    files: NotificationFile[];
    plaintiffFullName?: string | null;
    plaintiffShortName?: string | null;
    draftValidation?: {
        status: string;
        issues: Array<{ severity: 'error' | 'warning'; message: string }>;
    } | null;
}) {
    const {
        msg,
        parsed,
        files,
        plaintiffFullName,
        plaintiffShortName,
        draftValidation,
    } = args;

    const header =
        `Original email:\n` +
        `Subject: ${msg.subject}\n` +
        `From: ${msg.from?.emailAddress?.address}\n` +
        `Received: ${msg.receivedDateTime}\n\n` +
        `Case:\n` +
        `Court: ${parsed.courtName ?? 'N/A'}\n` +
        `Case: ${parsed.caseNumber ?? 'N/A'}\n` +
        `Title: ${parsed.caseTitle ?? 'N/A'}\n` +
        `Plaintiff (full): ${plaintiffFullName ?? ''}\n` +
        `Plaintiff (short): ${plaintiffShortName ?? ''}\n\n` +
        `Documents:\n`;

    const docs = files
        .map(
            f =>
                `- ${f.displayName || f.fileName}\n` +
                (f.webUrl ? `  OneDrive: ${f.webUrl}\n` : ''),
        )
        .join('\n');

    const validation = draftValidation
        ? `\n\nFiling Draft:\n` +
          `Status: ${draftValidation.status}\n` +
          `Automatic submission: ${draftValidation.issues.length ? 'BLOCKED - correction or review required' : 'READY'}\n` +
          (draftValidation.issues.length
              ? draftValidation.issues
                  .map(issue => `- ${issue.severity.toUpperCase()}: ${issue.message}`)
                  .join('\n')
              : '- Standard first-hearing nonpayment package passed validation.')
        : '';

    return header + docs + validation;
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
