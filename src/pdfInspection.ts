import { fork, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import path from 'node:path';

export type PdfReadOperation = 'pages' | 'fields';
export type PdfTextField = { name: string; value: string };
export type PdfReadResult = { pages: string[] } | { fields: PdfTextField[] };

export class PdfInspectionError extends Error {
    constructor(readonly code: string, message: string) { super(message); this.name = 'PdfInspectionError'; }
}

export function pdfInspectionTimeout(environment: NodeJS.ProcessEnv = process.env): number {
    const value = Number(environment.PDF_INSPECTION_TIMEOUT_MS);
    return Number.isFinite(value) && value > 0 ? Math.min(120_000, Math.max(1_000, Math.floor(value))) : 60_000;
}

const failed = () => new PdfInspectionError('PDF_INSPECTION_FAILED',
    'The PDF cannot be read completely or requires a password. Replace it with an unlocked, readable PDF.');
const busy = () => new PdfInspectionError('PDF_INSPECTION_BUSY',
    'PDF checking is busy. Retry this file shortly; no document has been submitted.');

function startPdfInspectionChild(): ChildProcess {
    const source = __filename.endsWith('.ts');
    return fork(path.join(__dirname, 'pdfInspectionChild' + (source ? '.ts' : '.js')), [], {
        cwd: path.resolve(__dirname, '..'),
        stdio: ['ignore', 'ignore', 'ignore', 'ipc'], serialization: 'advanced', ...{ windowsHide: true },
        execArgv: ['--max-old-space-size=256', ...(source ? ['-r', require.resolve('ts-node/register/transpile-only')] : [])],
        env: { ...Object.fromEntries(Object.entries(process.env).filter(([key]) =>
            /^(?:path|systemroot|temp|tmp|tmpdir|home|userprofile|lang|lc_all)$/i.test(key))),
            ...(source ? { TS_NODE_PROJECT: path.join(__dirname, '..', 'tsconfig.json') } : {}) },
    });
}

export function runPdfInspection(operation: PdfReadOperation, buffer: Buffer, options: {
    timeoutMs?: number; startChild?: () => ChildProcess; keepAlive?: boolean;
} = {}): Promise<PdfReadResult> {
    return new Promise((resolve, reject) => {
        let child: ChildProcess;
        try {
            child = options.startChild ? options.startChild() : startPdfInspectionChild();
        } catch { reject(failed()); return; }
        let result: PdfReadResult | undefined, error: Error | undefined, settled = false;
        const stopOnExit = () => { child.kill('SIGKILL'); };
        process.once('exit', stopOnExit);
        const timer = setTimeout(() => {
            error = new PdfInspectionError('PDF_INSPECTION_TIMEOUT',
                'This PDF took too long to check. Retry it or replace it with a readable PDF. Other files can continue.');
            child.kill('SIGKILL');
        }, options.timeoutMs ?? pdfInspectionTimeout());
        const finish = () => {
            if (settled) return;
            settled = true; clearTimeout(timer); process.removeListener('exit', stopOnExit);
            child.removeListener('error', onError); child.removeListener('exit', finish); child.removeListener('message', onMessage);
            if (error || !result) reject(error || failed()); else resolve(result);
        };
        const onError = () => { error = failed(); child.kill('SIGKILL'); finish(); };
        const onMessage = (message: any) => {
            const validPages = operation === 'pages' && Array.isArray(message?.pages) &&
                message.pages.length > 0 && message.pages.length <= 500 && message.pages.every((page: unknown) => typeof page === 'string');
            const validFields = operation === 'fields' && Array.isArray(message?.fields) && message.fields.length <= 10_000 &&
                message.fields.every((field: any) => typeof field?.name === 'string' && typeof field?.value === 'string');
            if (validPages) result = { pages: message.pages };
            else if (validFields) result = { fields: message.fields };
            else if (message?.error === 'limit') error = new PdfInspectionError('PDF_INSPECTION_LIMIT',
                'The PDF is too complex to check safely. Split it into smaller documents or replace it with a simpler PDF.');
            else error = failed();
            if (!error && options.keepAlive) finish(); else child.kill('SIGKILL');
        };
        child.on('error', onError); child.once('exit', finish); child.once('message', onMessage);
        child.send({ operation, pdf: buffer }, sendError => {
            if (sendError && !settled) { error = failed(); child.kill('SIGKILL'); }
        });
    });
}

export function createPdfInspectionReader(startChild = startPdfInspectionChild, options: {
    idleMs?: number; maxReads?: number; timeoutMs?: number;
} = {}): (operation: PdfReadOperation, buffer: Buffer) => Promise<PdfReadResult> {
    let child: ChildProcess | undefined, idle: NodeJS.Timeout | undefined, reads = 0, active = false;
    return async (operation, buffer) => {
        if (active) throw busy();
        active = true;
        let current: ChildProcess | undefined;
        try {
            clearTimeout(idle);
            if (!child || !child.connected || child.killed || child.exitCode !== null || child.signalCode !== null) {
                try { child = startChild(); } catch { throw failed(); }
                reads = 0;
                const spawned = child;
                const stop = () => { spawned.kill('SIGKILL'); };
                process.once('exit', stop);
                spawned.on('error', () => {});
                spawned.once('close', () => { process.removeListener('exit', stop); if (child === spawned) child = undefined; });
            }
            current = child;
            current.ref(); current.channel?.ref();
            const running = current;
            return await runPdfInspection(operation, buffer, { startChild: () => running,
                keepAlive: ++reads < (options.maxReads ?? 50), timeoutMs: options.timeoutMs });
        } finally {
            active = false;
            if (current && child === current && current.connected && !current.killed) {
                // Idle parsers must not keep a CLI/test alive or survive their parent.
                current.unref(); current.channel?.unref();
                const sleeping = current;
                idle = setTimeout(() => { if (child === sleeping) child = undefined; sleeping.kill('SIGKILL'); }, options.idleMs ?? 15_000).unref();
            }
        }
    };
}

interface PendingRead {
    operation: PdfReadOperation; buffer: Buffer;
    resolve(value: PdfReadResult): void; reject(error: Error): void; timer?: NodeJS.Timeout;
}

/** One parser at a time, with bounded waiting and no shared mutable PDF objects. */
export class PdfInspectionQueue {
    private active = false;
    private pending: PendingRead[] = [];
    private inFlight = new Map<string, Promise<PdfReadResult>>();
    private cache = new Map<string, { expires: number; result: PdfReadResult; bytes: number }>();
    constructor(private readonly read = createPdfInspectionReader(), private readonly maxPending = 4,
        private readonly waitMs = 30_000) {}

    async inspect(operation: PdfReadOperation, buffer: Buffer): Promise<PdfReadResult> {
        const snapshot = Buffer.from(buffer);
        const key = operation + ':' + createHash('sha256').update(snapshot).digest('hex');
        const cached = this.cache.get(key);
        if (cached && cached.expires > Date.now()) return structuredClone(cached.result);
        this.cache.delete(key);
        const existing = this.inFlight.get(key);
        if (existing) return structuredClone(await existing);
        if (this.active && this.pending.length >= this.maxPending) throw busy();
        const promise = new Promise<PdfReadResult>((resolve, reject) => {
            const pending: PendingRead = { operation, buffer: snapshot, resolve, reject };
            pending.timer = setTimeout(() => {
                const index = this.pending.indexOf(pending);
                if (index < 0) return;
                this.pending.splice(index, 1); reject(busy());
            }, this.waitMs);
            this.pending.push(pending); this.pump();
        });
        this.inFlight.set(key, promise);
        try {
            const result = await promise;
            const bytes = JSON.stringify(result).length * 2;
            if (bytes <= 1_000_000) {
                this.cache.set(key, { result: structuredClone(result), bytes, expires: Date.now() + 120_000 });
                while (this.cache.size > 4 || [...this.cache.values()].reduce((sum, entry) => sum + entry.bytes, 0) > 2_000_000) {
                    this.cache.delete(this.cache.keys().next().value!);
                }
            }
            return structuredClone(result);
        } finally { this.inFlight.delete(key); }
    }

    private pump(): void {
        if (this.active) return;
        const next = this.pending.shift();
        if (!next) return;
        clearTimeout(next.timer); this.active = true;
        void Promise.resolve().then(() => this.read(next.operation, next.buffer)).then(next.resolve, next.reject)
            .finally(() => { this.active = false; this.pump(); });
    }
}

export const pdfInspection = new PdfInspectionQueue();
