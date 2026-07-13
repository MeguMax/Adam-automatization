export interface PdfValidationResult {
    valid: boolean;
    reason?: string;
}

const PDF_HEADER_SCAN_BYTES = 1024;
const PDF_TRAILER_SCAN_BYTES = 16 * 1024;

/**
 * Performs lightweight structural validation without trusting the filename,
 * HTTP content type, or a file-size threshold.
 */
export function validatePdfBuffer(buffer: Buffer): PdfValidationResult {
    if (!buffer.length) {
        return { valid: false, reason: 'The download was empty' };
    }

    const leading = buffer
        .subarray(0, Math.min(buffer.length, PDF_HEADER_SCAN_BYTES))
        .toString('latin1');
    const headerIndex = leading.indexOf('%PDF-');

    if (headerIndex < 0) {
        const leadingText = leading.trimStart().toLowerCase();
        if (leadingText.startsWith('<!doctype html') || leadingText.startsWith('<html')) {
            return { valid: false, reason: 'The server returned HTML instead of a PDF' };
        }
        return { valid: false, reason: 'The PDF header (%PDF-) was not found' };
    }

    const trailer = buffer
        .subarray(Math.max(0, buffer.length - PDF_TRAILER_SCAN_BYTES))
        .toString('latin1');
    if (!trailer.includes('%%EOF')) {
        return { valid: false, reason: 'The PDF end marker (%%EOF) was not found; the download may be incomplete' };
    }

    return { valid: true };
}

export function isValidPdfBuffer(buffer: Buffer): boolean {
    return validatePdfBuffer(buffer).valid;
}
