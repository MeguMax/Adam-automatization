import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { spawnSync } from 'node:child_process';
import { createAdminAuth } from './adminAuth';
import { createExcelPdfHandler, EXCEL_FORMS, excelManifest, generateExcelPdf, validateExcelValues } from './excelPdf';
import { createExcelOneDriveDelivery, excelPdfFilename, ExcelPdfDelivery } from './excelPdfDelivery';

const row = require('../excel-addin/row.js');
const workbook = require('../excel-addin/workbook.js');
const values = (id = 'dc105'): Record<string, unknown> => Object.fromEntries(EXCEL_FORMS.find(form => form.id === id)!.fields.map(field => [field, '']));

function officeFixture() {
    const form=EXCEL_FORMS[0];
    const state={headers:['Defendant','Landlord','Court_Name','Case_Number',...form.fields],
        values:['Morgan Tenant','Example Property LLC','29th','26-00001-LT',...form.fields.map(()=>'' as string|number|boolean|null)],
        rowIndex:35,rowCount:1,width:form.fields.length+4,calculations:0,waits:0,reads:0,selectionReads:0,
        states:['Done'],date:'10/5/2026',moveSelection:false,moveSheet:false};
    let currentState='Done';
    const sheet={id:'sheet-1',name:'Working Document',load(){return this;},getUsedRange(){return {
        columnIndex:0,get columnCount(){return state.width;},load(){return this;}};},
        getRangeByIndexes(index:number){return {get values(){state.reads++;return [index===0?state.headers:[...state.values]];},
            get valueTypes(){return [state.values.map(value=>typeof value==='number'?'Double':'String')];},
            getCell(){return {};},load(){return this;}};}};
    const excel={CalculationType:{recalculate:'Recalculate'},CalculationState:{done:'Done'},run:async(callback:any)=>callback({
        sync:async()=>{},application:{calculate(){state.calculations++;},get calculationState(){return currentState;},
            load(){if(state.states.length) currentState=state.states.shift()!;}},
        workbook:{getSelectedRange(){state.selectionReads++;return {rowIndex:state.rowIndex+(state.moveSelection&&state.selectionReads>1?1:0),
            rowCount:state.rowCount,worksheet:state.moveSheet&&state.selectionReads>1?{...sheet,id:'sheet-2'}:sheet,load(){return this;}};},
            functions:{text(){return {get value(){return state.date;},load(){return this;}};}}},
    })};
    return {state,form,excel,sleep:async()=>{state.waits++;}};
}

test('Excel adapter waits for calculation, reads the current row and lets Excel format date serials',async()=>{
    const {state,form,excel,sleep}=officeFixture();
    state.states=['Calculating','Calculating','Done','Done','Done'];
    state.values[state.headers.indexOf('dc105_24')]=46300;
    const data=await workbook.readSelection(excel,form,{sleep});
    assert.equal(state.calculations,1);assert.equal(state.waits,2);
    assert.equal(data.values.dc105_24,'10/5/2026');assert.equal(data.row,36);assert.equal(data.sheetId,'sheet-1');
    assert.equal(data.metadata.plaintiff,'Example Property LLC');
});
test('Excel adapter times out busy calculation without reading cached field values',async()=>{
    const {state,form,excel,sleep}=officeFixture();state.states=['Calculating'];
    await assert.rejects(workbook.readSelection(excel,form,{sleep,timeoutMs:0}),/still calculating/);
    assert.equal(state.reads,0);
});
test('snapshot rechecks do not force another recalculation and reject row or sheet changes',async()=>{
    const first=officeFixture();
    await workbook.readSelection(first.excel,first.form,{recalculate:false,sleep:first.sleep});
    assert.equal(first.state.calculations,0);
    for(const key of ['moveSelection','moveSheet'] as const) {
        const fixture=officeFixture();fixture.state[key]=true;
        await assert.rejects(workbook.readSelection(fixture.excel,fixture.form,{sleep:fixture.sleep}),/worksheet changed/);
    }
});
test('selection, duplicate case identity and invalid date values stop the Office adapter',async()=>{
    for(const input of [{rowIndex:0},{rowIndex:1.5},{rowCount:2},{width:2049}]) {
        const fixture=officeFixture();Object.assign(fixture.state,input);
        await assert.rejects(workbook.readSelection(fixture.excel,fixture.form,{sleep:fixture.sleep}));
    }
    const duplicate=officeFixture();duplicate.state.headers.push('Defendant');duplicate.state.values.push('Different person');duplicate.state.width++;
    await assert.rejects(workbook.readSelection(duplicate.excel,duplicate.form,{sleep:duplicate.sleep}),/Duplicate case column/);
    for(const value of [46300.5,46300]) {
        const fixture=officeFixture();fixture.state.values[fixture.state.headers.indexOf('dc105_24')]=value;fixture.state.date='2/29/1900';
        await assert.rejects(workbook.readSelection(fixture.excel,fixture.form,{sleep:fixture.sleep}));
    }
});
test('case snapshots and filenames bind PDF values and identity without unsafe path characters',async()=>{
    const fixture=officeFixture();
    const data=await workbook.readSelection(fixture.excel,fixture.form,{sleep:fixture.sleep});
    assert.equal(workbook.sameSnapshot(data,structuredClone(data)),true);
    for(const change of [{row:37},{sheetId:'another-sheet'},{form:'dc508'},{values:{...data.values,dc105_05:'Changed'}},
        {metadata:{...data.metadata,caseNumber:'Different'}}]) assert.equal(workbook.sameSnapshot(data,{...data,...change}),false);
    assert.equal(row.pdfFilename(data),'DC105 - 29th - 26-00001-LT - Example Property LLC v Morgan Tenant.pdf');
    const unsafe=row.pdfFilename({...data,metadata:{...data.metadata,defendant:'A/B:C*D?"E<F>G|H\\I\n'},name:'Tenant'});
    assert.ok(!/[<>:"/\\|?*\x00-\x1f]/.test(unsafe));
    assert.ok(row.pdfFilename({...data,metadata:{defendant:'a'.repeat(400)}}).length<=174);
    assert.equal(row.isCalendarDate('2/29/2024'),true);
    for(const date of ['2/29/1900','2/30/2026','13/1/2026','1/0/2026','#VALUE!']) assert.equal(row.isCalendarDate(date),false);
});

async function fixture(run: (base: string, advance: (ms: number) => void) => Promise<void>, generate?: typeof generateExcelPdf, delivery: ExcelPdfDelivery | null = null) {
    const saved = { ADMIN_USERNAME: process.env.ADMIN_USERNAME, ADMIN_PASSWORD: process.env.ADMIN_PASSWORD, NODE_ENV: process.env.NODE_ENV };
    Object.assign(process.env, { ADMIN_USERNAME: 'admin', ADMIN_PASSWORD: 'test-password', NODE_ENV: 'test' });
    let clock = Date.now();
    const handler = createExcelPdfHandler({ now: () => clock, generate, delivery });
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
    assert.ok(excelManifest().includes('MinVersion="1.9"'));
    assert.equal(workbook.MIN_EXCEL_API,'1.9');
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
    for (const asset of ['app.js', 'row.js', 'workbook.js', 'commands.html', 'commands.js', 'style.css', 'icon.png', 'icon-16.png', 'icon-32.png', 'icon-80.png', 'lucide.js', 'catalog', 'manifest.xml', 'pdfjs/pdf.mjs', 'pdfjs/pdf.worker.mjs']) assert.equal((await fetch(base + '/excel/' + asset)).status, 200);
    assert.equal((await fetch(base + '/excel/pdfjs/standard_fonts/nonexistent')).status, 404);
    assert.equal((await fetch(base + '/excel/templates/dc105.pdf')).status, 404);
    assert.equal((await post(base, 'generate', { form: 'dc105', values: {} }, await login(base))).status, 422);
}));

test('Excel ribbon opens the task pane without running generation or requiring new permissions', async () => fixture(async base => {
    const manifest = await (await fetch(base + '/excel/manifest.xml')).text();
    for (const required of ['<Version>1.2.0.0</Version>', '<OfficeTab id="TabHome">', '<Action xsi:type="ShowTaskpane">',
        '<TaskpaneId>Devlin.PdfForms.Panel</TaskpaneId>', '<Permissions>ReadWriteDocument</Permissions>']) assert.ok(manifest.includes(required));
    assert.ok(!manifest.includes('ExecuteFunction'));
    assert.ok(!manifest.includes('https://localhost'));
    for (const size of [16, 32, 80]) {
        const response = await fetch(base + '/excel/icon-' + size + '.png');
        assert.equal(response.headers.get('content-type'), 'image/png');
        const metadata = await require('sharp')(Buffer.from(await response.arrayBuffer())).metadata();
        assert.equal(metadata.width, size); assert.equal(metadata.height, size);
    }
    const commands = await (await fetch(base + '/excel/commands.html')).text();
    assert.ok(commands.includes('/excel/commands.js'));
    const init = await (await fetch(base + '/excel/commands.js')).text();
    let calls = 0;
    require('node:vm').runInNewContext(init, { Office: { onReady: (callback: () => void) => { calls++; callback(); } } });
    assert.equal(calls, 1);
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

test('Excel delivery is opt-in and generated names cannot introduce file paths', () => {
    assert.equal(createExcelOneDriveDelivery({ ONEDRIVE_ROOT_SHARE_URL: 'https://example.sharepoint.com/court-folder' }), undefined);
    assert.equal(excelPdfFilename('dc105', undefined), 'DC105.pdf');
    assert.equal(excelPdfFilename('dc105', 'DC105 - QA-1 - Example.pdf'), 'DC105 - QA-1 - Example.pdf');
    for (const filename of ['../DC105.pdf', 'DC105 - a/b.pdf', 'DC105 - a\\b.pdf', 'DC508 - Other.pdf', 'DC105 - X.pdf.exe', 'DC105 - trailing.pdf ', 'DC105 - ' + 'a'.repeat(180) + '.pdf']) {
        assert.throws(() => excelPdfFilename('dc105', filename));
    }
});

test('OneDrive save uses only a session-owned generated PDF and expires independently of the login', async () => {
    const content = Buffer.from('%PDF-original-generated-by-server');
    const calls: string[] = [];
    const delivery: ExcelPdfDelivery = { destination: async () => ({name:'Excel Forms'}), save: async (name, bytes) => {
        assert.deepEqual(bytes,content); calls.push(name); return {name,url:'https://example.sharepoint.com/forms/generated.pdf'};
    } };
    await fixture(async (base,advance) => {
        assert.equal((await post(base,'delivery',{})).status,401);
        const token = await login(base);
        assert.equal((await post(base,'delivery',{},token,'https://untrusted.example')).status,403);
        assert.deepEqual(await (await post(base,'delivery',{},token)).json(),{available:true,name:'Excel Forms'});
        assert.equal((await post(base,'generate',{form:'dc105',values:values(),filename:'../wrong.pdf'},token)).status,422);
        const result = await post(base,'generate',{form:'dc105',values:values(),filename:'DC105 - QA-1 - Example.pdf'},token);
        const generationId = result.headers.get('x-excel-generation-id');
        assert.ok(generationId);
        const other = await login(base);
        assert.equal((await post(base,'save',{generationId},other)).status,410);
        assert.equal((await post(base,'save',{generationId:'unknown'},token)).status,410);
        const [first,second] = await Promise.all([post(base,'save',{generationId,pdf:'untrusted'},token),post(base,'save',{generationId},token)]);
        assert.equal(first.status,200); assert.equal(second.status,200); assert.equal(calls.length,1);
        assert.equal((await post(base,'save',{generationId},token)).status,200); assert.equal(calls.length,1);
        advance(5*60_000+1);
        assert.equal((await post(base,'save',{generationId},token)).status,410);
        assert.equal((await post(base,'delivery',{},token)).status,200);
    }, async () => content,delivery);
});

test('OneDrive retry keeps the same server PDF and cache capacity is bounded', async () => {
    let saves = 0, generations = 0;
    const delivery: ExcelPdfDelivery = { destination:async()=>({name:'Excel Forms'}), save:async name=>{
        if (++saves===1) throw new Error('Temporary save failure');
        return {name,url:'https://example.sharepoint.com/saved.pdf'};
    } };
    await fixture(async base=>{
        const token = await login(base);
        const ids: string[] = [];
        for (let n=0;n<9;n++) {
            const response = await post(base,'generate',{form:'dc105',values:values()},token);
            assert.equal(response.status,200); ids.push(response.headers.get('x-excel-generation-id')!);
        }
        assert.equal((await post(base,'save',{generationId:ids[0]},token)).status,410);
        assert.equal((await post(base,'save',{generationId:ids[8]},token)).status,503);
        assert.equal((await post(base,'save',{generationId:ids[8]},token)).status,200);
        assert.equal(generations,9); assert.equal(saves,2);
        await post(base,'logout',{},token);
        assert.equal((await post(base,'save',{generationId:ids[8]},token)).status,401);
        const newToken=await login(base);
        assert.equal((await post(base,'save',{generationId:ids[8]},newToken)).status,410);
    },async()=>{generations++;return Buffer.from('%PDF-test');},delivery);
});

test('only one distinct cloud save runs at a time and optional delivery failures do not block generation',async()=>{
    let release:()=>void=()=>{};
    let started:()=>void=()=>{};
    const active=new Promise<void>(resolve=>{started=resolve;});
    const gate=new Promise<void>(resolve=>{release=resolve;});
    const delivery:ExcelPdfDelivery={destination:async()=>{throw new Error('No folder access');},save:async name=>{
        started();await gate;return {name,url:'https://example.sharepoint.com/saved.pdf'};
    }};
    await fixture(async base=>{
        const token=await login(base);
        assert.equal((await post(base,'delivery',{},token)).status,503);
        const first=await post(base,'generate',{form:'dc105',values:values()},token);
        const second=await post(base,'generate',{form:'dc105',values:values()},token);
        const saving=post(base,'save',{generationId:first.headers.get('x-excel-generation-id')},token);
        await active;
        assert.equal((await post(base,'save',{generationId:second.headers.get('x-excel-generation-id')},token)).status,503);
        assert.equal((await post(base,'generate',{form:'dc105',values:values()},token)).status,200);
        assert.equal((await fetch(base+'/excel/catalog')).status,200);
        release();assert.equal((await saving).status,200);
    },async()=>Buffer.from('%PDF-fixture'),delivery);
});

test('download-only mode does not retain a cloud handle or accept save requests',async()=>fixture(async base=>{
    const token=await login(base);
    assert.deepEqual(await (await post(base,'delivery',{},token)).json(),{available:false});
    const generated=await post(base,'generate',{form:'dc105',values:values()},token);
    assert.equal(generated.status,200);assert.equal(generated.headers.has('x-excel-generation-id'),false);
    assert.equal((await post(base,'save',{generationId:'arbitrary'},token)).status,409);
},async()=>Buffer.from('%PDF-fixture')));

function driveFixture(options: {existing?:Buffer; uncertain?:boolean; invalidHost?:boolean; wrongFolder?:boolean; race?:boolean}={}) {
    const pdf=Buffer.from('%PDF-fictional-excel-form');
    const state={file:options.existing, name:'', uploads:0, sessions:0, paths:[] as string[], contentReads:0};
    const share='https://example.sharepoint.com/:f:/r/Excel?e=demo+slash/';
    const client={api:(url:string)=>{
        state.paths.push(url);
        const request={options:(input:any)=>{assert.ok(input.signal);return request;},select:()=>request,responseType:()=>request,
            get:async()=>{
                if(url.startsWith('/shares/')) {
                    assert.equal(url,'/shares/u!'+Buffer.from(share).toString('base64url')+'/driveItem');
                    return {id:'folder-1',name:'Excel Forms',folder:{},parentReference:{driveId:'drive-1'}};
                }
                if(url.endsWith('/content')) {state.contentReads++;return new Response(new Uint8Array(state.file!));}
                if(!state.file) throw Object.assign(new Error('Not found'),{statusCode:404});
                return {id:'saved-1',name:state.name || decodeURIComponent(url.split(':/')[1]),size:state.file.length,file:{},
                    webUrl:'https://example.sharepoint.com/forms/saved.pdf',parentReference:{id:options.wrongFolder?'another-folder':'folder-1',driveId:'drive-1'}};
            },
            post:async(input:any)=>{
                state.sessions++;assert.equal(input.item['@microsoft.graph.conflictBehavior'],'fail');
                state.name=input.item.name;
                return {uploadUrl:options.invalidHost?'https://untrusted.example/secret':'https://example.up.1drv.com/upload?secret=not-logged'};
            }};
        return request;
    }};
    const upload:typeof fetch=async(_url,init)=>{
        state.uploads++;
        assert.equal(init?.method,'PUT'); assert.equal(init?.redirect,'error');
        assert.deepEqual(Buffer.from(init?.body as Uint8Array),pdf);
        assert.equal(new Headers(init?.headers).has('Authorization'),false);
        assert.equal(new Headers(init?.headers).get('Content-Range'),`bytes 0-${pdf.length-1}/${pdf.length}`);
        state.file=Buffer.from(pdf);
        if(options.uncertain) throw new TypeError('Network error including secret upload URL');
        return new Response(null,{status:options.race?409:201});
    };
    const delivery=createExcelOneDriveDelivery({EXCEL_PDF_ONEDRIVE_SHARE_URL:share},{client:client as any,upload})!;
    return {pdf,state,delivery};
}

test('OneDrive delivery verifies saved bytes and reuses the same file without changing sharing',async()=>{
    const {pdf,state,delivery}=driveFixture();
    assert.deepEqual(await delivery.destination(),{name:'Excel Forms'});
    const saved=await delivery.save('DC105 - Example.pdf',pdf);
    assert.match(saved.name,/^DC105 - Example - [a-f0-9]{20}\.pdf$/);
    assert.equal((await delivery.save('DC105 - Example.pdf',pdf)).url,saved.url);
    assert.equal(state.sessions,1);assert.equal(state.uploads,1);assert.equal(state.contentReads,2);
    assert.equal(state.paths.some(path=>path.includes('createLink')),false);
});

test('uncertain OneDrive writes are verified on retry instead of duplicated',async()=>{
    const {pdf,state,delivery}=driveFixture({uncertain:true});
    await assert.rejects(delivery.save('DC105 - Example.pdf',pdf),error=>{
        assert.ok(!(error as Error).message.includes('secret'));return true;
    });
    const saved=await delivery.save('DC105 - Example.pdf',pdf);
    assert.ok(saved.url);assert.equal(state.sessions,1);assert.equal(state.uploads,1);
    const race=driveFixture({race:true});
    assert.ok((await race.delivery.save('DC105 - Example.pdf',race.pdf)).url);
});

test('OneDrive never overwrites mismatched content and rejects unexpected hosts or folders',async()=>{
    const mismatch=driveFixture({existing:Buffer.from('%PDF-fictional-excel-forn')});
    await assert.rejects(mismatch.delivery.save('DC105 - Example.pdf',mismatch.pdf),/not overwritten/);
    assert.equal(mismatch.state.uploads,0);
    const moved=driveFixture({existing:Buffer.from('%PDF-fictional-excel-form'),wrongFolder:true});
    await assert.rejects(moved.delivery.save('DC105 - Example.pdf',moved.pdf),/not overwritten/);
    const malicious=driveFixture({invalidHost:true});
    await assert.rejects(malicious.delivery.save('DC105 - Example.pdf',malicious.pdf),/unavailable/);
    assert.equal(malicious.state.uploads,0);
});
const pythonAvailable = spawnSync(python, ['-c', 'import pypdf,openpyxl'], { windowsHide: true }).status === 0;
test('all three packaged templates generate verified interactive PDFs through the isolated worker', { skip: !pythonAvailable && 'Set EXCEL_PDF_PYTHON to the installed Python runtime' }, async () => {
    for (const form of EXCEL_FORMS) {
        const input = values(form.id);
        const plaintiffField = {dc105:'dc105_05',dc508:'dc508_06',mc202:'mc202_08'}[form.id]!;
        input[plaintiffField] = 'Example Property LLC';
        const pdf = await generateExcelPdf(form.id, input, python);
        const check = spawnSync(python, ['-c', 'import sys,io,json; from pypdf import PdfReader; r=PdfReader(io.BytesIO(sys.stdin.buffer.read())); f=r.get_fields(); print(json.dumps({"fields":len(f),"pages":len(r.pages),"value":f[sys.argv[1]]["/V"],"blank":sum(bool(x.get("/V")) and str(x.get("/V")) != "/Off" for x in f.values())}))', plaintiffField], { input: pdf, windowsHide: true });
        assert.equal(check.status, 0, check.stderr.toString());
        const result = JSON.parse(check.stdout.toString());
        assert.equal(result.fields, form.count); assert.equal(result.pages, form.pages);
        assert.equal(result.value, 'Example Property LLC'); assert.equal(result.blank, 1);
    }
});
