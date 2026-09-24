/** Replies and forwards of our reports are correspondence, not new source PDFs. */
export function isProcessingReportSubject(subject: unknown): boolean {
    const value = String(subject || '').trim().replace(/^(?:(?:re|fw|fwd)\s*:\s*)+/i, '');
    return /^(?:MiFILE\/TrueFiling (?:processed|retry completed):|ERROR processing MiFILE\/TrueFiling email:)/i.test(value);
}
