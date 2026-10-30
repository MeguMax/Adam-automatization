import path from 'node:path';
import { createCanvas } from '@napi-rs/canvas';
import { createWorker, PSM } from 'tesseract.js';
import type { Page as RecognizedPage } from 'tesseract.js';
import sharp from 'sharp';
import { mergeOcrRegionWords, type OcrPage, type OcrLine } from './pdfOcr';
import { pdfResourceOptions } from './pdfValidation';
import { readComplaintSelections } from './pdfCheckboxes';

sharp.concurrency(1);

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
        if (numbers.some(number => !Number.isInteger(number) || number < 1 || number > pdf.numPages)) throw new Error('An OCR page number is outside this PDF.');
        worker = await createWorker('eng', 1, {
            langPath: path.join(path.dirname(require.resolve('@tesseract.js-data/eng/package.json')), '4.0.0_best_int'),
            cacheMethod: 'none', errorHandler: () => {},
        });
        await worker.setParameters({ tessedit_pageseg_mode: PSM.AUTO, user_defined_dpi: '300' });
        const pages: OcrPage[] = [];
        for (const number of numbers) {
            const page = await pdf.getPage(number);
            const base = page.getViewport({ scale: 1 });
            const scale = Math.min(300 / 72, Math.sqrt(8_000_000 / (base.width * base.height)));
            const viewport = page.getViewport({ scale });
            const canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
            await page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise;
            const image = await sharp(canvas.toBuffer('image/png')).flatten({ background: '#fff' }).greyscale().normalize().png().toBuffer();
            const pixelWidth = canvas.width, pixelHeight = canvas.height;
            canvas.width = 1; canvas.height = 1;
            page.cleanup();
            const xScale = 612 / viewport.width, yScale = 792 / viewport.height;
            const convert = (data: RecognizedPage, offsetX = 0, offsetY = 0): OcrPage => {
                const lines = (data.blocks || []).flatMap(block => block.paragraphs.flatMap(paragraph => paragraph.lines.map(line => ({
                    text: line.text.trim(), confidence: line.confidence,
                    x: (line.bbox.x0 + offsetX) * xScale, y: (line.bbox.y0 + offsetY) * yScale,
                    width: (line.bbox.x1 - line.bbox.x0) * xScale,
                    height: (line.bbox.y1 - line.bbox.y0) * yScale, pageNumber: number,
                }))));
                const words = (data.blocks || []).flatMap(block => block.paragraphs.flatMap(paragraph => paragraph.lines.flatMap(line => line.words.map(word => ({
                    text: word.text.trim(), confidence: word.confidence,
                    x: (word.bbox.x0 + offsetX) * xScale, y: (word.bbox.y0 + offsetY) * yScale,
                    width: (word.bbox.x1 - word.bbox.x0) * xScale,
                    height: (word.bbox.y1 - word.bbox.y0) * yScale, pageNumber: number,
                })))));
                return { text: data.text, confidence: data.confidence, lines, words, rotationRadians: data.rotateRadians || 0 };
            };
            let recognized = convert((await worker.recognize(image, { rotateAuto: true }, { text: true, blocks: true })).data);
            let passes = 1;
            if (recognized.confidence < 75 || !recognized.words.length) {
                await worker.setParameters({ tessedit_pageseg_mode: PSM.SPARSE_TEXT });
                const retry = convert((await worker.recognize(image, { rotateAuto: true }, { text: true, blocks: true })).data);
                passes++;
                const quality = (candidate: OcrPage) => candidate.words.filter(word => word.confidence >= 80 && /[a-z0-9]{2}/i.test(word.text)).length;
                if (quality(retry) > quality(recognized)) recognized = retry;
            }
            // Separate columns and form rules can confuse full-page segmentation.
            // Re-read caption blocks, not the whole document, for names/addresses.
            if (/complaint/i.test(recognized.text) && Math.abs(recognized.rotationRadians || 0) < 0.015) {
                for (const word of recognized.words.filter(word => word.x < 200 && word.y > 45 && word.y < 110 &&
                    word.confidence < 80 && /^\d{1,3}[AB]?(?:-\d)?(?:st|nd|rd|th)$/i.test(word.text))) {
                    const crop = {left:Math.max(0,Math.floor((word.x-2)/xScale)),top:Math.max(0,Math.floor((word.y-2)/yScale)),
                        width:Math.ceil((word.width+4)/xScale),height:Math.ceil((word.height+4)/yScale)};
                    if (crop.left+crop.width>pixelWidth || crop.top+crop.height>pixelHeight) continue;
                    await worker.setParameters({tessedit_pageseg_mode:PSM.SINGLE_WORD});
                    const reread=(await worker.recognize(image,{rectangle:crop},{text:true,blocks:true})).data;
                    passes++;
                    if (reread.text.trim().toUpperCase()===word.text.toUpperCase() && reread.confidence>=80) word.confidence=reread.confidence;
                }
                const rows = (items: OcrLine[]) => {
                    const grouped: OcrLine[][] = [];
                    for (const word of [...items].sort((a,b)=>a.y-b.y || a.x-b.x)) {
                        const row = grouped.find(row => Math.abs(row[0].y - word.y) < 5);
                        if (row) row.push(word); else grouped.push([word]);
                    }
                    return grouped.map(row => ({ x: Math.min(...row.map(w=>w.x)), y: Math.min(...row.map(w=>w.y)),
                        height: Math.max(...row.map(w=>w.y+w.height))-Math.min(...row.map(w=>w.y)),
                        text: row.sort((a,b)=>a.x-b.x).map(w=>w.text).join(' ') }));
                };
                const left = rows(recognized.words.filter(word => word.x + word.width / 2 < 300));
                const right = rows(recognized.words.filter(word => word.x + word.width / 2 >= 300));
                const plaintiff = left.find(row => /plaintiff.{0,8}name/i.test(row.text));
                const defendant = right.find(row => /defendant.{0,8}name/i.test(row.text));
                const attorney = left.find(row => /plaintiff.{0,8}attorney/i.test(row.text));
                const states = rows(recognized.words).find(row => /\b(?:the\s+)?plaintiff\s+states\b/i.test(row.text));
                const related = rows(recognized.words).find(row => /there is no other pending/i.test(row.text));
                for (const [label, end, xMax, column] of [
                    [plaintiff, attorney?.y, 289, left], [defendant, states?.y, 585, right],
                    [attorney, related?.y, 289, left],
                ] as const) {
                    if (!label || end === undefined || end <= label.y + 20) continue;
                    const xMin = Math.max(0, label.x - 1);
                    const firstData = column.find(row => row.y > label.y + 5 && row.y < end - 2);
                    if (!firstData) continue;
                    // Closely printed captions can start immediately below the label.
                    // Crop from the first data row, not a padded label bounding box.
                    const top = firstData.y - 1, bottom = end - 2;
                    const crop = { left: Math.round(xMin / xScale), top: Math.round(top / yScale),
                        width: Math.round((xMax-xMin) / xScale), height: Math.round((bottom-top) / yScale) };
                    if (crop.width <= 0 || crop.height <= 0 || crop.left + crop.width > pixelWidth || crop.top + crop.height > pixelHeight) continue;
                    await worker.setParameters({ tessedit_pageseg_mode: PSM.SINGLE_BLOCK });
                    const padding = 16;
                    const cropped = await sharp(image).extract(crop).extend({top:padding,bottom:padding,left:padding,right:padding,
                        background:'#fff'}).png().toBuffer();
                    const data = (await worker.recognize(cropped, {}, { text: true, blocks: true })).data;
                    const block = convert(data, crop.left-padding, crop.top-padding);
                    passes++;
                    if (!block.words.length) continue;
                    recognized.words = mergeOcrRegionWords(recognized.words, block.words,
                        {left:xMin,top,right:xMax,bottom});
                }
            }
            await worker.setParameters({ tessedit_pageseg_mode: PSM.AUTO });
            if (Math.abs(recognized.rotationRadians || 0) < 0.015) {
                const raw = await sharp(image).toColourspace('srgb').ensureAlpha().raw().toBuffer({resolveWithObject:true});
                recognized.selections = readComplaintSelections(new Uint8ClampedArray(raw.data.buffer,raw.data.byteOffset,raw.data.length),
                    raw.info.width,raw.info.height,recognized.words.filter(word=>word.confidence>=50));
            }
            pages.push({ ...recognized, recognitionPasses: passes });
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
