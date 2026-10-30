import { fork } from 'node:child_process';
import path from 'node:path';
import type { ComplaintSelections } from './pdfCheckboxes';

export interface OcrLine {
    text: string;
    confidence: number;
    x: number;
    y: number;
    width: number;
    height: number;
    pageNumber: number;
}
export interface OcrPage {
    selections?: ComplaintSelections;
    text: string;
    confidence: number;
    lines: OcrLine[];
    words: OcrLine[];
    rotationRadians?: number;
    recognitionPasses?: number;
}

export interface OcrRegion { left: number; top: number; right: number; bottom: number }

/** A second pass may repair missing words, but conflicting spellings stay uncertain. */
export function mergeOcrRegionWords(words: OcrLine[], reread: OcrLine[], region: OcrRegion): OcrLine[] {
    const inside = (word: OcrLine) => word.x + word.width / 2 >= region.left &&
        word.x + word.width / 2 < region.right && word.y + word.height / 2 >= region.top &&
        word.y + word.height / 2 < region.bottom;
    const overlap = (a: OcrLine, b: OcrLine) => {
        const area = Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x)) *
            Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y));
        return area / Math.max(1, Math.min(a.width * a.height, b.width * b.height));
    };
    const prior = words.filter(inside), next = reread.filter(inside), used = new Set<OcrLine>();
    const normalize = (value: string) => value.replace(/[^a-z0-9]/gi, '').toLowerCase();
    const merged = prior.map(word => {
        const matches = next.filter(candidate => candidate.pageNumber === word.pageNumber && overlap(word, candidate) > 0.5);
        if (matches.length !== 1 || prior.filter(other => overlap(other, matches[0]) > 0.5).length !== 1) return word;
        const candidate = matches[0]; used.add(candidate);
        if (normalize(word.text) === normalize(candidate.text)) {
            return {...word, confidence:Math.max(word.confidence, candidate.confidence)};
        }
        return {...word, confidence:Math.min(79, word.confidence)};
    });
    for (const word of next) {
        if (!used.has(word) && word.confidence >= 80 && !prior.some(other => overlap(other, word) > 0.15)) merged.push(word);
    }
    return [...words.filter(word => !inside(word)), ...merged];
}

let queue: Promise<unknown> = Promise.resolve();

/** One isolated OCR process at a time; a bad PDF must not take down the web server. */
export function recognizeScannedPdf(buffer: Buffer, pageNumbers?: number[]): Promise<OcrPage[]> {
    if (pageNumbers && (!pageNumbers.length || pageNumbers.some(page => !Number.isInteger(page) || page < 1) || new Set(pageNumbers).size !== pageNumbers.length)) {
        return Promise.reject(new Error('OCR page numbers must be unique positive integers.'));
    }
    const run = () => new Promise<OcrPage[]>((resolve, reject) => {
        const child = fork(path.join(__dirname, 'pdfOcrChild.js'), [], {
            stdio: ['ignore', 'ignore', 'pipe', 'ipc'], ...{ windowsHide: true },
            execArgv: ['--max-old-space-size=384'],
        });
        let settled = false;
        const timer = setTimeout(() => finish(new Error('Scan recognition timed out. Review this PDF or upload a clearer scan.')), 120_000);
        function finish(error?: Error, pages?: OcrPage[]) {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            child.kill();
            if (error) reject(error); else resolve(pages || []);
        }
        child.stderr?.resume();
        child.once('error', error => finish(error));
        child.once('exit', code => { if (!settled) finish(new Error(`Scan recognition stopped (${code}). The original PDF is preserved.`)); });
        child.on('message', (message: any) => {
            if (message.error) finish(new Error(message.error));
            else finish(undefined, message.pages);
        });
        child.send({ pdf: buffer.toString('base64'), pageNumbers });
    });
    const result = queue.then(run, run);
    queue = result.catch(() => undefined);
    return result;
}
