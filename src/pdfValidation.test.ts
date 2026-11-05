import assert from 'node:assert/strict';
import test from 'node:test';
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import { promisify } from 'node:util';
import { inspectFilingPdf, readFilingTextFields, validatePdfBuffer } from './pdfValidation';
import { PdfInspectionQueue, createPdfInspectionReader, pdfInspectionTimeout, runPdfInspection, type PdfReadResult } from './pdfInspection';
import { testComplaintFormFixture, testPdfFixture } from './testPdfFixture';

const validPdf = Buffer.from(
    '%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\ntrailer\n<< /Root 1 0 R >>\n%%EOF\n',
    'ascii',
);

test('accepts a structurally complete PDF regardless of its size', () => {
    assert.deepEqual(validatePdfBuffer(validPdf), { valid: true });
});

test('rejects HTML and truncated PDF data', () => {
    assert.match(
        validatePdfBuffer(Buffer.from('<html>Sign in</html>', 'utf8')).reason ?? '',
        /HTML/,
    );
    assert.match(
        validatePdfBuffer(Buffer.from('%PDF-1.7\npartial', 'ascii')).reason ?? '',
        /end marker/,
    );
});

test('filing inspection reads real PDF pages and rejects a header/trailer-only fake', async () => {
    await inspectFilingPdf(testPdfFixture());
    await assert.rejects(inspectFilingPdf(validPdf), /cannot be read/);
});

test('isolated PDF reads retain AcroForm values and return independent cached copies', async () => {
    const bytes = testComplaintFormFixture();
    const pages = await inspectFilingPdf(bytes);
    assert.ok(pages[0].includes('COMPLAINT'));
    const fields = await readFilingTextFields(bytes);
    assert.ok(fields.some(field => field.name === 'dc102a_05' && field.value.includes('Example Property')));
    const original = structuredClone(fields);
    fields[0].value = 'Local edit';
    pages[0] = 'Local edit';
    assert.deepEqual(await readFilingTextFields(bytes), original);
    assert.notEqual((await inspectFilingPdf(bytes))[0], 'Local edit');
});

test('the source-mode parser works under ts-node even when the current directory is outside the project', async () => {
    const root = path.resolve(__dirname, '..');
    const script = `const {inspectFilingPdf}=require(${JSON.stringify(path.join(root, 'src', 'pdfValidation.ts'))});` +
        `const {testPdfFixture}=require(${JSON.stringify(path.join(root, 'src', 'testPdfFixture.ts'))});` +
        `inspectFilingPdf(testPdfFixture('Source mode')).then(p=>{if(!p[0].includes('Source mode'))throw new Error('Mismatch');console.log('source-parser-ok');}).catch(()=>{process.exitCode=1});`;
    const result = await promisify(execFile)(process.execPath,
        ['-r', require.resolve('ts-node/register/transpile-only'), '-e', script], {
            cwd: os.tmpdir(), windowsHide: true, timeout: 30_000,
            env: { ...process.env, TS_NODE_PROJECT: path.join(root, 'tsconfig.json') },
        });
    assert.match(result.stdout, /source-parser-ok/);
});

test('the inspection deadline is bounded without changing PDF size-based validation', () => {
    assert.equal(pdfInspectionTimeout({}), 60_000);
    assert.equal(pdfInspectionTimeout({ PDF_INSPECTION_TIMEOUT_MS: 'not-a-number' }), 60_000);
    assert.equal(pdfInspectionTimeout({ PDF_INSPECTION_TIMEOUT_MS: '-1' }), 60_000);
    assert.equal(pdfInspectionTimeout({ PDF_INSPECTION_TIMEOUT_MS: '1' }), 1_000);
    assert.equal(pdfInspectionTimeout({ PDF_INSPECTION_TIMEOUT_MS: '999999999' }), 120_000);
});

function fixtureChild(script: string): ChildProcess {
    return spawn(process.execPath, ['-e', script], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'], windowsHide: true });
}

test('a CPU-bound PDF worker is killed at its deadline while the main event loop stays responsive', async () => {
    let child: ChildProcess | undefined, responsive = false;
    const timer = setTimeout(() => { responsive = true; }, 25);
    try {
        await assert.rejects(runPdfInspection('pages', testPdfFixture(), {
            timeoutMs: 400, startChild: () => child = fixtureChild("process.on('message', () => { while (true) {} });"),
        }), (error: any) => error.code === 'PDF_INSPECTION_TIMEOUT');
        assert.equal(responsive, true);
        assert.equal(child?.signalCode, 'SIGKILL', 'The worker must exit before the next PDF starts');
        assert.ok((await inspectFilingPdf(testPdfFixture('Following valid document')))[0].includes('Following valid document'));
    } finally { clearTimeout(timer); child?.kill('SIGKILL'); }
});

test('crashed, malformed and unavailable workers return bounded errors without exposing their input', async () => {
    for (const script of ["process.on('message', () => process.exit(17));",
        "process.on('message', () => process.send({ pages: [null], error: 'private diagnostic text' }));"]) {
        await assert.rejects(runPdfInspection('pages', validPdf, { timeoutMs: 5_000, startChild: () => fixtureChild(script) }),
            (error: any) => error.code === 'PDF_INSPECTION_FAILED' && !error.message.includes('private diagnostic'));
    }
    await assert.rejects(runPdfInspection('pages', validPdf, { startChild: () => { throw new Error('private path'); } }),
        (error: any) => error.code === 'PDF_INSPECTION_FAILED' && !error.message.includes('private path'));
});

test('a warm parser is reused, recycled and restarted after a failed read without leaving child processes', async () => {
    const children: ChildProcess[] = [];
    const read = createPdfInspectionReader(() => {
        const child = fixtureChild("process.on('message', input => { if (input.pdf.data[0] === 0) process.exit(17); else process.send({pages: ['Read text']}); });");
        children.push(child); return child;
    }, { idleMs: 30, maxReads: 3, timeoutMs: 5_000 });
    try {
        await read('pages', Buffer.from([1])); await read('pages', Buffer.from([2]));
        assert.equal(children.length, 1);
        assert.equal(children[0].listenerCount('message'), 0);
        await read('pages', Buffer.from([3]));
        assert.equal(children[0].signalCode, 'SIGKILL');
        await assert.rejects(read('pages', Buffer.from([0])), (error: any) => error.code === 'PDF_INSPECTION_FAILED');
        await read('pages', Buffer.from([4])); assert.equal(children.length, 3);
        const current = children[children.length - 1];
        await new Promise<void>((resolve, reject) => {
            const deadline = setTimeout(() => reject(new Error('Idle parser did not exit')), 2_000);
            current.once('exit', () => { clearTimeout(deadline); resolve(); });
        });
        assert.equal(current.signalCode, 'SIGKILL');
    } finally { children.forEach(child => child.kill('SIGKILL')); }
});

test('a parser session cannot mix concurrent callers or become locked after startup failure', async () => {
    let child: ChildProcess | undefined, starts = 0;
    const read = createPdfInspectionReader(() => {
        if (++starts === 1) throw new Error('Private startup diagnostic');
        return child = fixtureChild("process.on('message', () => setTimeout(() => process.send({pages: ['One document']}), 100));");
    }, { idleMs: 30, timeoutMs: 5_000 });
    try {
        await assert.rejects(read('pages', validPdf), (error: any) =>
            error.code === 'PDF_INSPECTION_FAILED' && !error.message.includes('Private'));
        const first = read('pages', validPdf);
        await assert.rejects(read('pages', Buffer.from('different document')), (error: any) => error.code === 'PDF_INSPECTION_BUSY');
        assert.deepEqual(await first, { pages: ['One document'] });
    } finally { child?.kill('SIGKILL'); }
});

test('identical pending reads share one worker, but callers cannot mutate each other or the cache', async () => {
    let release!: (result: PdfReadResult) => void, reads = 0;
    const queue = new PdfInspectionQueue(async () => { reads++; return new Promise(resolve => { release = resolve; }); });
    const first = queue.inspect('pages', validPdf), second = queue.inspect('pages', validPdf);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(reads, 1); release({ pages: ['Original text'] });
    const a = await first, b = await second;
    assert.ok('pages' in a && 'pages' in b); a.pages[0] = 'Changed';
    assert.equal(b.pages[0], 'Original text');
    assert.deepEqual(await queue.inspect('pages', validPdf), { pages: ['Original text'] });
    assert.equal(reads, 1);
});

test('a failed parser releases the serialized queue and is not cached as a success', async () => {
    let active = 0, maximum = 0, reads = 0;
    const queue = new PdfInspectionQueue(async () => {
        maximum = Math.max(maximum, ++active); reads++;
        await new Promise(resolve => setImmediate(resolve)); active--;
        if (reads === 1) throw new Error('Broken PDF');
        return { pages: ['Valid text'] };
    });
    const first = assert.rejects(queue.inspect('pages', Buffer.from('broken')), /Broken PDF/);
    const second = queue.inspect('pages', Buffer.from('valid'));
    await first; assert.deepEqual(await second, { pages: ['Valid text'] });
    assert.deepEqual(await queue.inspect('pages', Buffer.from('broken')), { pages: ['Valid text'] });
    assert.equal(maximum, 1); assert.equal(reads, 3);
});

test('a queued PDF is pinned to its original bytes even if the caller edits its Buffer', async () => {
    let release!: (result: PdfReadResult) => void;
    const observed: string[] = [];
    const queue = new PdfInspectionQueue(async (_operation, bytes) => {
        observed.push(bytes.toString());
        if (observed.length === 1) return new Promise(resolve => { release = resolve; });
        return { pages: [bytes.toString()] };
    });
    const first = queue.inspect('pages', Buffer.from('active'));
    const bytes = Buffer.from('original'), pending = queue.inspect('pages', bytes);
    bytes.fill('x');
    await new Promise(resolve => setImmediate(resolve)); release({ pages: ['active'] }); await first;
    assert.deepEqual(await pending, { pages: ['original'] });
    assert.deepEqual(observed, ['active', 'original']);
    assert.deepEqual(await queue.inspect('pages', Buffer.from('original')), { pages: ['original'] });
    assert.equal(observed.length, 2);
});

test('the PDF backlog is bounded and an expired queued PDF never starts a worker', async () => {
    let release!: (result: PdfReadResult) => void, reads = 0;
    const queue = new PdfInspectionQueue(async () => { reads++; return new Promise(resolve => { release = resolve; }); }, 1, 30);
    const first = queue.inspect('pages', Buffer.from('first'));
    const second = assert.rejects(queue.inspect('pages', Buffer.from('second')), (error: any) => error.code === 'PDF_INSPECTION_BUSY');
    await assert.rejects(queue.inspect('pages', Buffer.from('overflow')), (error: any) => error.code === 'PDF_INSPECTION_BUSY');
    await second; assert.equal(reads, 1);
    release({ pages: ['First text'] }); await first;
    assert.equal(reads, 1);
});
