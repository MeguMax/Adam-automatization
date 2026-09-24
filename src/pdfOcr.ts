import { fork } from 'node:child_process';
import path from 'node:path';

export interface OcrLine {
    text: string;
    confidence: number;
    x: number;
    y: number;
    width: number;
    height: number;
    pageNumber: number;
}
export interface OcrPage { text: string; confidence: number; lines: OcrLine[]; words: OcrLine[] }
let queue: Promise<unknown> = Promise.resolve();

/** One isolated OCR process at a time; a bad PDF must not take down the web server. */
export function recognizeScannedPdf(buffer: Buffer, pageNumbers?: number[]): Promise<OcrPage[]> {
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
