import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { spawnSync } from 'node:child_process';
import { createAdminAuth } from './adminAuth';
import { createExcelPdfHandler, EXCEL_FORMS, excelManifest, generateExcelPdf, validateExcelValues } from './excelPdf';

const row = require('../excel-addin/row.js');
const values = (id = 'dc105'): Record<string, unknown> => Object.fromEntries(EXCEL_FORMS.find(form => form.id === id)!.fields.map(field => [field, '']));

async function fixture(run: (base: string, advance: (ms: number) => void) => Promise<void>, generate?: typeof generateExcelPdf) {
    const saved = { ADMIN_USERNAME: process.env.ADMIN_USERNAME, ADMIN_PASSWORD: process.env.ADMIN_PASSWORD, NODE_ENV: process.env.NODE_ENV };
    Object.assign(process.env, { ADMIN_USERNAME: 'admin', ADMIN_PASSWORD: 'test-password', NODE_ENV: 'test' });
    let clock = Date.now();
    const handler = createExcelPdfHandler({ now: () => clock, generate });
    const admin = createAdminAuth();
    const server = http.createServer(async (req, res) => {
        if (await handler(req, res, new URL(req.url!, 'http://localhost').pathname)) return;
        if (await admin(req, res, '/api/protected')) res.end('protected');
    });
    server.listen(0, '127.0.0.1'); await once(server, 'listening');
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    try { await run(base, ms => { clock += ms; }); }
    finally {
        await new Promise<void>(resolve => { server.close(() => resolve()); server.closeIdleConnections(); });
        for (const [key, value] of Object.entries(saved)) if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
}

async function post(base: string, endpoint: string, data: unknown, token = '', origin = base) {
    return fetch(base + '/excel/' + endpoint, { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) }, body: JSON.stringify(data) });
}
async function login(base: string): Promise<string> {
    const response = await post(base, 'session', { username: 'admin', password: 'test-password' });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('set-cookie'), null);
    return (await response.json()).token;
}

test('Excel row mapping uses exact headers, rejects errors/duplicates, and ignores unrelated formula errors', () => {
    const form = EXCEL_FORMS[0];
    const headers = [...form.fields, 'Unrelated'];
    const mapped = row.selectedFields(headers, [...form.fields.map(() => ''), '#REF!'], [...form.fields.map(() => 'String'), 'Error'], form);
    assert.equal(Object.keys(mapped.values).length, 48);
    assert.throws(() => row.selectedFields([...headers, form.fields[0]], [...Object.values(mapped.values), '', ''], [], form), /Duplicate/);
    assert.throws(() => row.selectedFields(headers.slice(1), [], [], form), /Missing/);
    assert.throws(() => row.selectedFields(headers, headers, ['Error'], form), /Excel error/);
    assert.throws(() => row.assertSelection({ rowIndex: 0, rowCount: 1 }), /header/);
    assert.throws(() => row.assertSelection({ rowIndex: 3, rowCount: 2 }), /multiple rows/);
    row.assertSelection({ rowIndex: 35, rowCount: 1 });
});

test('generation input cannot choose a path, introduce extra fields, or send ambiguous numeric dates', () => {
    assert.throws(() => validateExcelValues('../file', {}), /available form/);
    assert.throws(() => validateExcelValues('dc105', { ...values(), extra: '' }), /exactly/);
    assert.throws(() => validateExcelValues('dc105', { ...values(), dc105_24: 46300 }), /format the date/);
    for (const value of ['#REF!', '#BUSY!', 'a'.repeat(4097), {}, []]) {
        assert.throws(() => validateExcelValues('dc105', { ...values(), dc105_05: value }));
    }
    validateExcelValues('dc105', { ...values(), dc105_24: '10/5/2026', dc105_11: true });
    assert.ok(excelManifest().includes('ExcelApi'));
    assert.throws(() => excelManifest('http://untrusted.example'), /HTTPS/);
    assert.throws(() => excelManifest('https://example.com/other'), /HTTPS/);
});

test('Excel sessions are scoped, cookie-independent, revoked on password change, logout and expiry', async () => fixture(async (base, advance) => {
    assert.equal((await post(base, 'generate', { form: 'dc105', values: values() })).status, 401);
    assert.equal((await post(base, 'session', { username: 'admin', password: 'wrong' })).status, 401);
    assert.equal((await post(base, 'session', { username: 'admin', password: 'test-password' }, '', 'https://untrusted.example')).status, 403);
    const token = await login(base);
    assert.equal((await fetch(base + '/api/protected', { headers: { Authorization: 'Bearer ' + token } })).status, 401);
    assert.equal((await post(base, 'generate', { form: 'dc105', values: values() }, token)).status, 200);
    assert.equal((await post(base, 'logout', {}, token)).status, 200);
    assert.equal((await post(base, 'generate', { form: 'dc105', values: values() }, token)).status, 401);
    const expired = await login(base); advance(30 * 60_000 + 1);
    assert.equal((await post(base, 'generate', { form: 'dc105', values: values() }, expired)).status, 401);
    const changed = await login(base); process.env.ADMIN_PASSWORD = 'new-password';
    assert.equal((await post(base, 'generate', { form: 'dc105', values: values() }, changed)).status, 401);
}, async () => Buffer.from('%PDF-fixture')));

test('Excel shell supports Office framing but never exposes templates or general admin sessions', async () => fixture(async base => {
    const shell = await fetch(base + '/excel/');
    assert.equal(shell.status, 200);
    const csp = shell.headers.get('content-security-policy')!;
    assert.ok(csp.includes('https://appsforoffice.microsoft.com'));
    assert.ok(csp.includes('https://*.officeapps.live.com'));
    assert.ok(!csp.includes('unsafe-inline'));
    for (const asset of ['app.js', 'row.js', 'style.css', 'icon.png', 'lucide.js', 'catalog', 'manifest.xml', 'pdfjs/pdf.mjs', 'pdfjs/pdf.worker.mjs']) assert.equal((await fetch(base + '/excel/' + asset)).status, 200);
    assert.equal((await fetch(base + '/excel/pdfjs/standard_fonts/nonexistent')).status, 404);
    assert.equal((await fetch(base + '/excel/templates/dc105.pdf')).status, 404);
    assert.equal((await post(base, 'generate', { form: 'dc105', values: {} }, await login(base))).status, 422);
}));

test('oversized and malformed JSON requests are rejected without invoking the PDF worker', async () => {
    let calls = 0;
    await fixture(async base => {
        const token = await login(base);
        const oversized = await post(base, 'generate', { form: 'dc105', values: values(), padding: 'x'.repeat(100_000) }, token);
        assert.equal(oversized.status, 422);
        const malformed = await fetch(base + '/excel/generate', { method: 'POST', headers: { Origin: base, 'Content-Type': 'application/json', Authorization: 'Bearer ' + token }, body: '{' });
        assert.equal(malformed.status, 422);
    }, async () => { calls++; return Buffer.from('%PDF-fixture'); });
    assert.equal(calls, 0);
});

test('login attempts are bounded and generation serializes without blocking independent admin requests', async () => fixture(async (base, advance) => {
    const token = await login(base);
    for (let attempt = 0; attempt < 20; attempt++) await post(base, 'session', {});
    const blocked = await post(base, 'session', {});
    assert.equal(blocked.status, 429); assert.equal(blocked.headers.get('retry-after'), '60');
    advance(60_001); await login(base);
    const first = post(base, 'generate', { form: 'dc105', values: values() }, token);
    await new Promise(resolve => setTimeout(resolve, 30));
    assert.equal((await post(base, 'generate', { form: 'dc105', values: values() }, token)).status, 503);
    assert.equal((await fetch(base + '/excel/catalog')).status, 200);
    assert.equal((await first).status, 200);
}, async () => { await new Promise(resolve => setTimeout(resolve, 150)); return Buffer.from('%PDF-fixture'); }));

const python = process.env.EXCEL_PDF_PYTHON || 'python3';
const pythonAvailable = spawnSync(python, ['-c', 'import pypdf,openpyxl'], { windowsHide: true }).status === 0;
test('all three packaged templates generate verified interactive PDFs through the isolated worker', { skip: !pythonAvailable && 'Set EXCEL_PDF_PYTHON to the installed Python runtime' }, async () => {
    for (const form of EXCEL_FORMS) {
        const input = values(form.id);
        input[form.id + '_05'] = 'Example Property LLC';
        const pdf = await generateExcelPdf(form.id, input, python);
        const check = spawnSync(python, ['-c', 'import sys,io,json; from pypdf import PdfReader; r=PdfReader(io.BytesIO(sys.stdin.buffer.read())); f=r.get_fields(); print(json.dumps({"fields":len(f),"pages":len(r.pages),"value":f[sys.argv[1]]["/V"],"blank":sum(bool(x.get("/V")) and str(x.get("/V")) != "/Off" for x in f.values())}))', form.id + '_05'], { input: pdf, windowsHide: true });
        assert.equal(check.status, 0, check.stderr.toString());
        const result = JSON.parse(check.stdout.toString());
        assert.equal(result.fields, form.count); assert.equal(result.pages, form.pages);
        assert.equal(result.value, 'Example Property LLC'); assert.equal(result.blank, 1);
    }
});
