import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { zipSync } from 'fflate';
import { credentialsMatch } from './adminAuth';
import { createExcelOneDriveDelivery, excelPdfFilename, ExcelPdfDelivery, ExcelPdfSavedCopy } from './excelPdfDelivery';

const ROOT = path.resolve(__dirname, '..');
export const EXCEL_SESSION_MS = 12 * 60 * 60_000;
const BODY_LIMIT = 96 * 1024;
export interface ExcelSessionStore {
    get(hash: string): { expires: number; version: string } | undefined;
    set(hash: string, session: { expires: number; version: string }): void;
    delete(hash: string): void;
    prune(now: number, keep: number): void;
}

function memorySessions(): ExcelSessionStore {
    const sessions = new Map<string, { expires: number; version: string }>();
    return {
        get: hash => sessions.get(hash),
        set: (hash, session) => { sessions.set(hash, session); },
        delete: hash => { sessions.delete(hash); },
        prune: (time, keep) => {
            for (const [hash, session] of sessions) if (session.expires <= time) sessions.delete(hash);
            while (sessions.size > keep) sessions.delete(sessions.keys().next().value!);
        },
    };
}

function tokenHash(token: string): string {
    return createHash('sha256').update(token).digest('hex');
}
export class ExcelPdfFieldError extends Error {
    constructor(message: string, public readonly field: string) { super(message); }
}
export const EXCEL_FORMS = [
    { id: 'dc105', title: 'DC105 Judgment', count: 48, pages: 1, dates: [24, 26, 41, 45, 47, 48] },
    { id: 'dc508', title: 'DC508 Conditional Dismissal', count: 28, pages: 2, dates: [13, 15] },
    { id: 'mc202', title: 'MC202 Certification of Records', count: 25, pages: 1, dates: [] },
].map(form => ({ ...form,
    fields: Array.from({ length: form.count }, (_, index) => `${form.id}_${String(index + 1).padStart(2, '0')}`),
    dateFields: form.dates.map(index => `${form.id}_${String(index).padStart(2, '0')}`),
}));

function credentialVersion(hash: string): string {
    return createHash('sha256').update(JSON.stringify(['excel-pdf', process.env.ADMIN_USERNAME, process.env.ADMIN_PASSWORD, hash])).digest('hex');
}

function sameOrigin(req: http.IncomingMessage): boolean {
    try {
        const origin = new URL(req.headers.origin || '');
        return origin.host === req.headers.host && req.headers['sec-fetch-site'] !== 'cross-site' &&
            (process.env.NODE_ENV === 'production' ? origin.protocol === 'https:' : ['https:', 'http:'].includes(origin.protocol));
    } catch { return false; }
}

async function body(req: http.IncomingMessage, limit = BODY_LIMIT): Promise<any> {
    return new Promise((resolve, reject) => {
        let size = 0;
        const chunks: Buffer[] = [];
        const timer = setTimeout(() => reject(new Error('Request timed out.')), 15_000);
        const finish = (error?: Error) => { clearTimeout(timer); if (error) reject(error); };
        req.on('error', finish);
        req.on('aborted', () => finish(new Error('Request cancelled.')));
        req.on('data', chunk => { size += chunk.length; if (size <= limit) chunks.push(Buffer.from(chunk)); });
        req.on('end', () => {
            finish();
            if (size > limit) return reject(new Error('Request is too large.'));
            try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
            catch { reject(new Error('Invalid JSON request.')); }
        });
    });
}

function json(res: http.ServerResponse, status: number, value: unknown): void {
    res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
    res.end(JSON.stringify(value));
}

export function validateExcelValues(formId: unknown, input: unknown): { form: typeof EXCEL_FORMS[number]; values: Record<string, unknown> } {
    const form = EXCEL_FORMS.find(item => item.id === formId);
    if (!form) throw new Error('Select an available form.');
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Calculated field values are required.');
    const values = input as Record<string, unknown>;
    if (Object.keys(values).length !== form.fields.length || Object.keys(values).some(key => !form.fields.includes(key))) {
        throw new Error('The selected form must contain exactly its matching PDF columns.');
    }
    for (const name of form.fields) {
        const value = values[name];
        if (value !== null && !['string', 'number', 'boolean'].includes(typeof value)) throw new Error(`Invalid value in ${name}.`);
        if (typeof value === 'number' && !Number.isFinite(value)) throw new Error(`Invalid number in ${name}.`);
        if (typeof value === 'string' && (value.length > 4096 || /^#(?:REF!|VALUE!|DIV\/0!|N\/A|NAME\?|NUM!|NULL!|SPILL!|CALC!|BUSY!|GETTING_DATA)$/.test(value))) {
            throw new Error(`Resolve the Excel value in ${name} before generating.`);
        }
        if (form.dateFields.includes(name) && typeof value === 'number') throw new Error(`Excel must format the date in ${name} before generating.`);
    }
    return { form, values };
}

export async function generateExcelPdf(formId: unknown, input: unknown, python = process.env.EXCEL_PDF_PYTHON || 'python3'): Promise<Buffer> {
    const { form, values } = validateExcelValues(formId, input);
    const template = path.join(ROOT, 'assets', 'excel-pdf', form.id + '.pdf');
    if (!fs.existsSync(template)) throw new Error('The selected PDF template is not installed.');
    return new Promise((resolve, reject) => {
        const child = spawn(python, ['-I', path.join(ROOT, 'tools', 'excel_pdf', 'http_worker.py'), template, form.id], {
            stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
        });
        let bytes = 0, errors = '';
        const chunks: Buffer[] = [];
        const timer = setTimeout(() => { child.kill(); reject(new Error('PDF generation timed out.')); }, 25_000);
        child.stdout.on('data', chunk => {
            bytes += chunk.length;
            if (bytes <= 5 * 1024 * 1024) chunks.push(chunk);
            else { child.kill(); reject(new Error('The generated PDF is too large.')); }
        });
        child.stderr.on('data', chunk => { if (errors.length < 2048) errors += chunk.toString('utf8'); });
        child.stdin.on('error', () => { /* Exit handling reports a failed worker. */ });
        child.once('error', () => { clearTimeout(timer); reject(new Error('The PDF generation runtime is unavailable.')); });
        child.once('close', code => {
            clearTimeout(timer);
            if (code !== 0) {
                if (code === 2) {
                    try {
                        const detail = JSON.parse(errors);
                        if (typeof detail?.error === 'string' && form.fields.includes(detail?.field)) {
                            return reject(new ExcelPdfFieldError(detail.error.slice(0, 1000), detail.field));
                        }
                    } catch { /* Older/local workers can still return a plain validation message. */ }
                }
                return reject(new Error(code === 2 ? errors.trim().slice(0, 1000) : 'PDF generation failed. Please contact support.'));
            }
            const output = Buffer.concat(chunks);
            if (!output.subarray(0, 5).equals(Buffer.from('%PDF-'))) return reject(new Error('Invalid PDF generation result.'));
            resolve(output);
        });
        child.stdin.end(JSON.stringify(values));
    });
}

export function validateExcelPackage(input: any) {
    if (!Array.isArray(input?.forms) || input.forms.length !== EXCEL_FORMS.length ||
        new Set(input.forms.map((item: any) => item?.form)).size !== EXCEL_FORMS.length) {
        throw new Error('The ZIP must contain DC105, DC508 and MC202 exactly once.');
    }
    // Validate the whole row before starting any PDF worker; never return a partial package.
    return EXCEL_FORMS.map(form => {
        const item = input.forms.find((candidate: any) => candidate?.form === form.id);
        validateExcelValues(form.id, item?.values);
        return { form: form.id, values: item.values as Record<string, unknown>, filename: excelPdfFilename(form.id, item.filename) };
    });
}

function publicAsset(res: http.ServerResponse, filename: string, type: string): void {
    res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer',
        'Content-Security-Policy': "default-src 'self'; script-src 'self' 'wasm-unsafe-eval' https://appsforoffice.microsoft.com; style-src 'self'; img-src 'self' data:; font-src 'self' blob:; worker-src 'self' blob:; connect-src 'self' https://appsforoffice.microsoft.com; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'self' https://onedrive.live.com https://*.officeapps.live.com https://*.office.com https://*.microsoft365.com https://*.cloud.microsoft https://*.sharepoint.com" });
    res.end(fs.readFileSync(filename));
}

export function excelManifest(base = process.env.EXCEL_PDF_PUBLIC_URL || 'https://legal-workflow-admin.onrender.com'): string {
    const url = new URL(base);
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.pathname !== '/') throw new Error('Excel add-in requires a public HTTPS origin.');
    const origin = url.origin.replace(/&/g, '&amp;').replace(/"/g, '&quot;');
    return `<?xml version="1.0" encoding="UTF-8"?>
<OfficeApp xmlns="http://schemas.microsoft.com/office/appforoffice/1.1" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:type="TaskPaneApp">
<Id>05cdad5d-041d-41c4-b8c9-9c33cf9d7c93</Id><Version>1.2.0.0</Version><ProviderName>Devlin Law PLLC</ProviderName><DefaultLocale>en-US</DefaultLocale>
<DisplayName DefaultValue="Devlin Law PDF Forms"/><Description DefaultValue="Generate fillable court PDFs from the selected Excel row."/>
<IconUrl DefaultValue="${origin}/excel/icon.png"/><SupportUrl DefaultValue="${origin}/excel/help"/>
<Hosts><Host Name="Workbook"/></Hosts><Requirements><Sets DefaultMinVersion="1.9"><Set Name="ExcelApi" MinVersion="1.9"/></Sets></Requirements>
<DefaultSettings><SourceLocation DefaultValue="${origin}/excel/"/></DefaultSettings><Permissions>ReadWriteDocument</Permissions>
<VersionOverrides xmlns="http://schemas.microsoft.com/office/taskpaneappversionoverrides" xmlns:bt="http://schemas.microsoft.com/office/officeappbasictypes/1.0" xsi:type="VersionOverridesV1_0">
<Requirements><bt:Sets DefaultMinVersion="1.1"><bt:Set Name="ExcelApi" MinVersion="1.9"/><bt:Set Name="AddinCommands" MinVersion="1.1"/></bt:Sets></Requirements>
<Hosts><Host xsi:type="Workbook"><DesktopFormFactor><FunctionFile resid="Devlin.Commands"/>
<ExtensionPoint xsi:type="PrimaryCommandSurface"><OfficeTab id="TabHome"><Group id="Devlin.PdfForms.Group"><Label resid="Devlin.Group"/>
<Icon><bt:Image size="16" resid="Devlin.Icon16"/><bt:Image size="32" resid="Devlin.Icon32"/><bt:Image size="80" resid="Devlin.Icon80"/></Icon>
<Control xsi:type="Button" id="Devlin.PdfForms.Open"><Label resid="Devlin.Button"/><Supertip><Title resid="Devlin.Button"/><Description resid="Devlin.Tooltip"/></Supertip>
<Icon><bt:Image size="16" resid="Devlin.Icon16"/><bt:Image size="32" resid="Devlin.Icon32"/><bt:Image size="80" resid="Devlin.Icon80"/></Icon>
<Action xsi:type="ShowTaskpane"><TaskpaneId>Devlin.PdfForms.Panel</TaskpaneId><SourceLocation resid="Devlin.Taskpane"/></Action>
</Control></Group></OfficeTab></ExtensionPoint></DesktopFormFactor></Host></Hosts>
<Resources><bt:Images><bt:Image id="Devlin.Icon16" DefaultValue="${origin}/excel/icon-16.png"/><bt:Image id="Devlin.Icon32" DefaultValue="${origin}/excel/icon-32.png"/><bt:Image id="Devlin.Icon80" DefaultValue="${origin}/excel/icon-80.png"/></bt:Images>
<bt:Urls><bt:Url id="Devlin.Commands" DefaultValue="${origin}/excel/commands.html"/><bt:Url id="Devlin.Taskpane" DefaultValue="${origin}/excel/"/></bt:Urls>
<bt:ShortStrings><bt:String id="Devlin.Group" DefaultValue="Devlin Law"/><bt:String id="Devlin.Button" DefaultValue="PDF Forms"/></bt:ShortStrings>
<bt:LongStrings><bt:String id="Devlin.Tooltip" DefaultValue="Open the selected case row and generate a fillable court PDF."/></bt:LongStrings></Resources>
</VersionOverrides></OfficeApp>`;
}

export function createExcelPdfHandler(options: { now?: () => number; generate?: typeof generateExcelPdf; delivery?: ExcelPdfDelivery | null; sessions?: ExcelSessionStore } = {}) {
    const now = options.now || Date.now;
    const sessions = options.sessions || memorySessions();
    const sessionFor = (token: string) => {
        if (!/^[a-f0-9]{64}$/.test(token)) return undefined;
        const hash = tokenHash(token);
        const session = sessions.get(hash);
        if (session && session.expires > now() && session.version === credentialVersion(hash)) return session;
        if (session) sessions.delete(hash);
        return undefined;
    };
    const delivery = options.delivery === undefined ? createExcelOneDriveDelivery() : options.delivery;
    const copies = new Map<string, { owner: string; pdf: Buffer; filename: string; expires: number; timer: NodeJS.Timeout; saved?: ExcelPdfSavedCopy; saving?: Promise<ExcelPdfSavedCopy> }>();
    const forget = (id: string) => { const copy = copies.get(id); if (copy) clearTimeout(copy.timer); copies.delete(id); };
    const prune = () => { for (const [id, copy] of copies) if (copy.expires <= now() || !sessionFor(copy.owner)) forget(id); };
    let attempts = 0, windowStart = now(), running = false, saving = false;
    return async (req: http.IncomingMessage, res: http.ServerResponse, pathname: string): Promise<boolean> => {
        if (!pathname.startsWith('/excel/') && pathname !== '/excel') return false;
        const assets: Record<string, [string, string]> = {
            '/excel/': ['taskpane.html', 'text/html; charset=utf-8'], '/excel': ['taskpane.html', 'text/html; charset=utf-8'],
            '/excel/help': ['help.html', 'text/html; charset=utf-8'], '/excel/help.css': ['help.css', 'text/css'],
            '/excel/app.js': ['app.js', 'text/javascript'], '/excel/row.js': ['row.js', 'text/javascript'],
            '/excel/workbook.js': ['workbook.js', 'text/javascript'],
            '/excel/session.js': ['session.js', 'text/javascript'],
            '/excel/commands.html': ['commands.html', 'text/html; charset=utf-8'], '/excel/commands.js': ['commands.js', 'text/javascript'],
            '/excel/icon-16.png': ['icon-16.png', 'image/png'], '/excel/icon-32.png': ['icon-32.png', 'image/png'], '/excel/icon-80.png': ['icon-80.png', 'image/png'],
            '/excel/style.css': ['style.css', 'text/css'], '/excel/icon.png': ['icon.png', 'image/png'],
        };
        if (req.method === 'GET' && assets[pathname]) {
            publicAsset(res, path.join(ROOT, 'excel-addin', assets[pathname][0]), assets[pathname][1]); return true;
        }
        if (req.method === 'GET' && pathname === '/excel/lucide.js') {
            publicAsset(res, require.resolve('lucide/dist/umd/lucide.min.js'), 'text/javascript'); return true;
        }
        if (req.method === 'GET' && ['/excel/pdfjs/pdf.mjs', '/excel/pdfjs/pdf.worker.mjs'].includes(pathname)) {
            publicAsset(res, require.resolve('pdfjs-dist/build/' + (pathname.endsWith('pdf.worker.mjs') ? 'pdf.worker.mjs' : 'pdf.mjs')), 'text/javascript'); return true;
        }
        const pdfAsset = pathname.match(/^\/excel\/pdfjs\/(standard_fonts|cmaps|wasm)\/([a-zA-Z0-9_.-]+)$/);
        if (req.method === 'GET' && pdfAsset) {
            const filename = path.join(path.dirname(require.resolve('pdfjs-dist/package.json')), pdfAsset[1], pdfAsset[2]);
            if (!fs.existsSync(filename) || !fs.statSync(filename).isFile()) { json(res, 404, { error: 'Resource not found.' }); return true; }
            publicAsset(res, filename, filename.endsWith('.wasm') ? 'application/wasm' : 'application/octet-stream'); return true;
        }
        if (req.method === 'GET' && pathname === '/excel/manifest.xml') {
            res.writeHead(200, { 'Content-Type': 'application/xml', 'Content-Disposition': 'attachment; filename="devlin-law-excel.xml"', 'Cache-Control': 'no-store' });
            res.end(excelManifest()); return true;
        }
        if (req.method === 'GET' && pathname === '/excel/catalog') { json(res, 200, EXCEL_FORMS); return true; }
        if (req.method !== 'POST' || !['/excel/session', '/excel/resume', '/excel/logout', '/excel/generate', '/excel/generate-package', '/excel/delivery', '/excel/save'].includes(pathname)) {
            json(res, 404, { error: 'Not found.' }); return true;
        }
        if (!sameOrigin(req) || !req.headers['content-type']?.startsWith('application/json')) {
            json(res, 403, { error: 'A same-origin JSON request is required.' }); return true;
        }
        sessions.prune(now(), 100);
        prune();
        if (pathname === '/excel/session') {
            if (now() - windowStart >= 60_000) { attempts = 0; windowStart = now(); }
            if (++attempts > 20) { res.setHeader('Retry-After', '60'); json(res, 429, { error: 'Too many sign-in attempts. Wait one minute.' }); return true; }
            let input;
            try { input = await body(req); } catch (error) { json(res, 400, { error: (error as Error).message }); return true; }
            if (!credentialsMatch(input?.username, input?.password)) { json(res, 401, { error: 'Incorrect admin username or password.' }); return true; }
            sessions.prune(now(), 99);
            const token = randomBytes(32).toString('hex');
            const hash = tokenHash(token), expiresAt = now() + EXCEL_SESSION_MS;
            sessions.set(hash, { expires: expiresAt, version: credentialVersion(hash) });
            json(res, 200, { token, expiresAt, expiresIn: EXCEL_SESSION_MS / 1000 }); return true;
        }
        const authorization = req.headers.authorization || '';
        const token = authorization.startsWith('Bearer ') ? authorization.slice(7) : '';
        const session = sessionFor(token);
        if (!session) { json(res, 401, { error: 'Your Excel connection expired. Connect again.' }); return true; }
        if (pathname === '/excel/resume') {
            json(res, 200, { expiresAt: session.expires, expiresIn: Math.ceil((session.expires - now()) / 1000) }); return true;
        }
        if (pathname === '/excel/logout') { sessions.delete(tokenHash(token)); prune(); json(res, 200, { ok: true }); return true; }
        if (pathname === '/excel/delivery') {
            try { json(res, 200, delivery ? { available: true, ...(await delivery.destination()) } : { available: false }); }
            catch { json(res, 503, { error: 'OneDrive is unavailable. PDF downloads still work.' }); }
            return true;
        }
        if (pathname === '/excel/save') {
            if (!delivery) { json(res, 409, { error: 'Excel OneDrive delivery is not configured.' }); return true; }
            try {
                const input = await body(req);
                const copy = typeof input?.generationId === 'string' ? copies.get(input.generationId) : undefined;
                if (!copy || copy.owner !== token) { json(res, 410, { error: 'This PDF is no longer available for OneDrive. Generate it again.' }); return true; }
                if (!copy.saved) {
                    if (!copy.saving) {
                        if (saving) { json(res, 503, { error: 'Another PDF is being saved. Retry in a moment.' }); return true; }
                        saving = true;
                        copy.saving = Promise.resolve().then(() => delivery.save(copy.filename, copy.pdf)).finally(() => { saving = false; });
                    }
                    try { copy.saved = await copy.saving; } finally { copy.saving = undefined; }
                }
                json(res, 200, copy.saved);
            } catch (error) { json(res, 503, { error: (error as Error).message }); }
            return true;
        }
        if (running) { res.setHeader('Retry-After', '3'); json(res, 503, { error: 'Another PDF is being generated. Retry in a moment.' }); return true; }
        running = true;
        try {
            if (pathname === '/excel/generate-package') {
                const items = validateExcelPackage(await body(req, 512 * 1024));
                const files: Record<string, Uint8Array> = {};
                for (const item of items) {
                    if (!sessionFor(token)) { json(res, 401, {error:'Your Excel connection expired. Connect again.'}); return true; }
                    if (res.destroyed) return true;
                    try {
                        const pdf = await (options.generate || generateExcelPdf)(item.form, item.values);
                        if (!pdf.subarray(0, 5).equals(Buffer.from('%PDF-')) || pdf.length > 5 * 1024 * 1024) throw new Error('Invalid PDF generation result.');
                        files[item.filename] = pdf;
                    } catch (error) {
                        json(res, 422, {error: item.form.toUpperCase() + ': ' + (error as Error).message,
                            form:item.form, ...(error instanceof ExcelPdfFieldError ? {field:error.field} : {})});
                        return true;
                    }
                }
                if (!sessionFor(token)) { json(res, 401, {error:'Your Excel connection expired. Connect again.'}); return true; }
                if (res.destroyed) return true;
                // PDFs are already compressed; storing them avoids blocking the event loop on recompression.
                const archive = Buffer.from(zipSync(files, {level:0}));
                res.writeHead(200, {'Content-Type':'application/zip', 'Content-Length':archive.length,
                    'Content-Disposition':'attachment; filename="Devlin-Law-forms.zip"',
                    'Cache-Control':'no-store', 'X-Content-Type-Options':'nosniff'});
                res.end(archive);
                return true;
            }
            const input = await body(req);
            validateExcelValues(input?.form, input?.values);
            const filename = excelPdfFilename(input.form, input.filename);
            const pdf = await (options.generate || generateExcelPdf)(input.form, input.values);
            if (!sessionFor(token)) { json(res, 401, {error:'Your Excel connection expired. Connect again.'}); return true; }
            let generationId = '';
            if (delivery && sessionFor(token)) {
                if (!pdf.subarray(0, 5).equals(Buffer.from('%PDF-')) || pdf.length > 5 * 1024 * 1024) throw new Error('Invalid PDF generation result.');
                let bytes = [...copies.values()].reduce((sum, copy) => sum + copy.pdf.length, 0);
                for (const [id, copy] of copies) {
                    if (copies.size < 8 && bytes + pdf.length <= 16 * 1024 * 1024) break;
                    bytes -= copy.pdf.length; forget(id);
                }
                generationId = randomBytes(24).toString('hex');
                const id = generationId;
                copies.set(id, { owner: token, pdf, filename, expires: now() + 5 * 60_000,
                    timer: setTimeout(() => forget(id), 5 * 60_000).unref() });
            }
            res.writeHead(200, { 'Content-Type': 'application/pdf', 'Content-Length': pdf.length, 'Cache-Control': 'no-store',
                'Content-Disposition': `attachment; filename="${input.form}.pdf"`, 'X-Content-Type-Options': 'nosniff',
                ...(generationId ? { 'X-Excel-Generation-Id': generationId } : {}) });
            res.end(pdf);
        } catch (error) { json(res, 422, { error: (error as Error).message,
            ...(error instanceof ExcelPdfFieldError ? { field: error.field } : {}) }); }
        finally { running = false; }
        return true;
    };
}
