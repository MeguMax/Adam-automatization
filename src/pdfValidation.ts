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

let pdfInspector: Promise<any> | null = null;

export async function inspectFilingPdf(buffer: Buffer): Promise<void> {
    const basic = validatePdfBuffer(buffer);
    if (!basic.valid) throw new Error(basic.reason || 'Invalid PDF');
    const nativeImport = new Function('specifier', 'return import(specifier)') as (specifier: string) => Promise<any>;
    pdfInspector ??= nativeImport('pdfjs-dist/legacy/build/pdf.mjs');
    const pdfJs = await pdfInspector;
    const task = pdfJs.getDocument({
        data: new Uint8Array(buffer), isEvalSupported: false, stopAtErrors: true,
        useSystemFonts: true, verbosity: pdfJs.VerbosityLevel.ERRORS,
    });
    try {
        const document = await task.promise;
        if (!document.numPages) throw new Error('The PDF has no pages');
        for (let number = 1; number <= document.numPages; number++) {
            const page = await document.getPage(number);
            await page.getOperatorList();
            page.cleanup();
        }
    } catch {
        throw new Error('The PDF cannot be read completely or requires a password. Replace it with an unlocked, readable PDF.');
    } finally {
        await task.destroy();
    }
}
