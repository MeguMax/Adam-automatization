import type { PdfReadOperation, PdfTextField } from './pdfInspection';
import { pdfResourceOptions } from './pdfValidation';

let reading = false;
process.on('message', async (input: { operation: PdfReadOperation; pdf: Buffer }) => {
    if (reading) { process.exit(1); return; }
    reading = true;
    let task: any;
    let result: { pages: string[] } | { fields: PdfTextField[] } | { error: 'limit' | 'unreadable' };
    try {
        if (!Buffer.isBuffer(input.pdf) || !['pages', 'fields'].includes(input.operation)) throw new Error('Invalid request');
        const nativeImport = new Function('specifier', 'return import(specifier)');
        const pdfJs = await nativeImport('pdfjs-dist/legacy/build/pdf.mjs');
        task = pdfJs.getDocument({ ...pdfResourceOptions(), data: new Uint8Array(input.pdf), isEvalSupported: false,
            stopAtErrors: true, useSystemFonts: true, verbosity: pdfJs.VerbosityLevel.ERRORS });
        const pdf = await task.promise;
        if (!pdf.numPages) throw new Error('Empty PDF');
        if (input.operation === 'fields' && pdf.numPages > 10) result = { fields: [] };
        else if (pdf.numPages > 500) result = { error: 'limit' };
        else {
            const pages: string[] = [], fields: PdfTextField[] = [];
            let textLength = 0;
            for (let number = 1; number <= pdf.numPages; number++) {
                const page = await pdf.getPage(number);
                if (input.operation === 'fields') {
                    for (const field of await page.getAnnotations()) if (field.fieldType === 'Tx' &&
                        typeof field.fieldName === 'string' && typeof field.fieldValue === 'string') {
                        fields.push({ name: field.fieldName, value: field.fieldValue });
                        textLength += field.fieldName.length + field.fieldValue.length;
                    }
                } else {
                    await page.getOperatorList();
                    const text = await page.getTextContent();
                    let previousY: number | null = null, lines = '';
                    for (const item of text.items) {
                        if (typeof item.str !== 'string') continue;
                        const y = item.transform?.[5] ?? null;
                        if (previousY !== null && y !== null && Math.abs(previousY - y) > 2) lines += '\n';
                        lines += item.str + (item.hasEOL ? '\n' : ' '); previousY = y;
                    }
                    pages.push(lines); textLength += lines.length;
                }
                page.cleanup();
                if (textLength > 2_000_000 || fields.length > 10_000) throw new RangeError('PDF result limit');
            }
            result = input.operation === 'fields' ? { fields } : { pages };
        }
    } catch (error) { result = { error: error instanceof RangeError ? 'limit' : 'unreadable' }; }
    finally { await task?.destroy().catch(() => {}); }
    reading = false;
    process.send?.(result!);
});
process.once('disconnect', () => process.exit(0));
