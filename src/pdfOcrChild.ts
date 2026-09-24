import path from 'node:path';
import { createCanvas } from '@napi-rs/canvas';
import { createWorker, PSM } from 'tesseract.js';
import type { OcrPage } from './pdfOcr';
import { pdfResourceOptions } from './pdfValidation';

process.once('message', async (input: { pdf: string; pageNumbers?: number[] }) => {
    let worker: Awaited<ReturnType<typeof createWorker>> | undefined;
    let task: any;
    try {
        const nativeImport = new Function('s', 'return import(s)');
        const pdfJs = await nativeImport('pdfjs-dist/legacy/build/pdf.mjs');
        task = pdfJs.getDocument({ data: new Uint8Array(Buffer.from(input.pdf, 'base64')),
            isEvalSupported: false, useSystemFonts: true,
            ...pdfResourceOptions(),
            verbosity: pdfJs.VerbosityLevel.ERRORS });
        const pdf = await task.promise;
        const numbers = input.pageNumbers || Array.from({ length: pdf.numPages }, (_, i) => i + 1);
        if (numbers.length > 12) throw new Error('This scan exceeds the 12-page OCR limit. Split the package into individual documents.');
        worker = await createWorker('eng', 1, {
            langPath: path.join(path.dirname(require.resolve('@tesseract.js-data/eng/package.json')), '4.0.0_best_int'),
            cacheMethod: 'none', errorHandler: () => {},
        });
        await worker.setParameters({ tessedit_pageseg_mode: PSM.AUTO });
        const pages: OcrPage[] = [];
        for (const number of numbers) {
            const page = await pdf.getPage(number);
            const base = page.getViewport({ scale: 1 });
            const scale = Math.min(3, Math.sqrt(8_000_000 / (base.width * base.height)));
            const viewport = page.getViewport({ scale });
            const canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
            await page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise;
            const { data } = await worker.recognize(canvas.toBuffer('image/png'), {}, { text: true, blocks: true });
            const lines = (data.blocks || []).flatMap(block => block.paragraphs.flatMap(paragraph => paragraph.lines.map(line => ({
                text: line.text.trim(), confidence: line.confidence,
                x: line.bbox.x0 / scale, y: line.bbox.y0 / scale,
                width: (line.bbox.x1 - line.bbox.x0) / scale,
                height: (line.bbox.y1 - line.bbox.y0) / scale, pageNumber: number,
            }))));
            const words = (data.blocks || []).flatMap(block => block.paragraphs.flatMap(paragraph => paragraph.lines.flatMap(line => line.words.map(word => ({
                text: word.text.trim(), confidence: word.confidence,
                x: word.bbox.x0 / scale, y: word.bbox.y0 / scale,
                width: (word.bbox.x1 - word.bbox.x0) / scale,
                height: (word.bbox.y1 - word.bbox.y0) / scale, pageNumber: number,
            })))));
            pages.push({ text: data.text, confidence: data.confidence, lines, words });
            canvas.width = 1; canvas.height = 1;
            page.cleanup();
        }
        process.send?.({ pages });
    } catch (error) {
        process.send?.({ error: error instanceof Error ? error.message : String(error) });
    } finally {
        await worker?.terminate();
        await task?.destroy();
        process.disconnect?.();
    }
});
