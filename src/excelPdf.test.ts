import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { once } from 'node:events';
import { spawnSync } from 'node:child_process';
import { unzipSync } from 'fflate';
import { createAdminAuth } from './adminAuth';
import { createExcelPdfHandler, EXCEL_FORMS, EXCEL_SESSION_MS, ExcelSessionStore, ExcelPdfFieldError, excelManifest, generateExcelPdf, validateExcelValues } from './excelPdf';
import { WorkflowDatabase } from './database';
import { createExcelOneDriveDelivery, excelPdfFilename, ExcelPdfDelivery } from './excelPdfDelivery';

const row = require('../excel-addin/row.js');
const workbook = require('../excel-addin/workbook.js');
const clientSessions = require('../excel-addin/session.js');
const values = (id = 'dc105'): Record<string, unknown> => Object.fromEntries(EXCEL_FORMS.find(form => form.id === id)!.fields.map(field => [field, '']));
const packageInput = () => ({forms: EXCEL_FORMS.map(form => ({form:form.id,values:values(form.id),filename:form.id.toUpperCase()+' - QA example.pdf'}))});

function officeFixture() {
    const form=EXCEL_FORMS[0];
    const state={headers:['Defendant','Landlord','Court_Name','Case_Number',...form.fields],
        values:['Morgan Tenant','Example Property LLC','29th','26-00001-LT',...form.fields.map(()=>'' as string|number|boolean|null)],
        rowIndex:35,rowCount:1,width:form.fields.length+4,calculations:0,waits:0,reads:0,selectionReads:0,
        states:['Done'],date:'10/5/2026',dateCalls:[] as string[],moveSelection:false,moveSheet:false};
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
            functions:{text(){throw new Error('Localized TEXT must not be used');},
                ...Object.fromEntries(['month','day','year'].map((name,index)=>[name,()=>{
                    state.dateCalls.push(name);
                    return {get value(){return Number(state.date.split('/')[index]);},load(){return this;}};
                }]))}},
    })};
    return {state,form,excel,sleep:async()=>{state.waits++;}};
}

test('Excel adapter waits for calculation, reads the current row and lets Excel resolve calendar components',async()=>{
    const {state,form,excel,sleep}=officeFixture();
    state.states=['Calculating','Calculating','Done','Done','Done'];
    state.values[state.headers.indexOf('dc105_24')]=46300;
    const data=await workbook.readSelection(excel,form,{sleep});
    assert.equal(state.calculations,1);assert.equal(state.waits,2);
    assert.equal(data.values.dc105_24,'10/5/2026');assert.equal(data.row,36);assert.equal(data.sheetId,'sheet-1');
    assert.equal(data.metadata.plaintiff,'Example Property LLC');
    assert.equal(data.columns.dc105_24,state.headers.indexOf('dc105_24'));
    assert.deepEqual(state.dateCalls,['month','day','year']);
});

test('date normalization uses locale-independent numeric Excel results and never guesses a serial-date epoch',async()=>{
    for (const [serial,date] of [[46322,'10/27/2026'],[44860,'10/27/2026'],[45351,'2/29/2024']] as const) {
        const fixture=officeFixture();fixture.state.date=date;
        fixture.state.values[fixture.state.headers.indexOf('dc105_24')]=serial;
        const data=await workbook.readSelection(fixture.excel,fixture.form,{sleep:fixture.sleep});
        assert.equal(data.values.dc105_24,date);
        assert.deepEqual(fixture.state.dateCalls,['month','day','year']);
    }
    for (const date of ['2/29/1900','2/30/2026','13/1/2026','10/27/2026.5','NaN/27/2026']) {
        const fixture=officeFixture();fixture.state.date=date;
        fixture.state.values[fixture.state.headers.indexOf('dc105_24')]=46322;
        await assert.rejects(workbook.readSelection(fixture.excel,fixture.form,{sleep:fixture.sleep}),/calendar date/);
    }
});
test('Excel adapter times out busy calculation without reading cached field values',async()=>{
    const {state,form,excel,sleep}=officeFixture();state.states=['Calculating'];
    await assert.rejects(workbook.readSelection(excel,form,{sleep,timeoutMs:0}),/still calculating/);
    assert.equal(state.reads,0);
});

test('three-form adapter reads one calculated row, formats both form date sets and guards every field', async () => {
    const {state,excel,sleep}=officeFixture();
    state.headers.push(...EXCEL_FORMS.slice(1).flatMap(form=>form.fields));
    state.values.push(...EXCEL_FORMS.slice(1).flatMap(form=>form.fields.map(()=>'')));
    state.width=state.headers.length;
    for (const field of ['dc105_24','dc508_13']) state.values[state.headers.indexOf(field)]=46300;
    const result=await workbook.readPackage(excel,EXCEL_FORMS,{sleep});
    assert.equal(state.calculations,1); assert.equal(Object.keys(result.values).length,101);
    assert.equal(result.values.dc508_13,'10/5/2026'); assert.equal(result.values.dc105_24,'10/5/2026');
    assert.equal(result.form,'package');
    const changed=structuredClone(result);changed.values.mc202_01='Different value';
    assert.equal(workbook.sameSnapshot(result,changed),false);
    state.headers.splice(state.headers.indexOf('mc202_01'),1);state.width--;
    await assert.rejects(workbook.readPackage(excel,EXCEL_FORMS,{sleep}),/Missing column: mc202_01/);
    await assert.rejects(workbook.readPackage(excel,EXCEL_FORMS.slice(1),{sleep}),/All three/);
});

test('ZIP endpoint validates all three forms before generation and is authenticated and same-origin', async () => {
    let calls=0;
    await fixture(async base=>{
        assert.equal((await post(base,'generate-package',packageInput())).status,401);
        const token=await login(base);
        assert.equal((await post(base,'generate-package',packageInput(),token,'https://foreign.example')).status,403);
        const missing=packageInput(); missing.forms.pop();
        const duplicate=packageInput(); duplicate.forms[2]=duplicate.forms[1];
        const invalidField=packageInput(); invalidField.forms[2].values.mc202_05='#REF!';
        const unsafe=packageInput(); unsafe.forms[2].filename='../../MC202.pdf';
        for (const input of [missing,duplicate,invalidField,unsafe,{forms:[null,null,null]}]) {
            assert.equal((await post(base,'generate-package',input,token)).status,422);
        }
        assert.equal(calls,0);
        const response=await post(base,'generate-package',packageInput(),token);
        assert.equal(response.status,200);assert.equal(calls,3);
        assert.equal(response.headers.get('content-type'),'application/zip');
        assert.equal(response.headers.get('cache-control'),'no-store');
        assert.equal(response.headers.has('x-excel-generation-id'),false);
        const files=unzipSync(new Uint8Array(await response.arrayBuffer()));
        assert.deepEqual(Object.keys(files),['DC105 - QA example.pdf','DC508 - QA example.pdf','MC202 - QA example.pdf']);
        for(const bytes of Object.values(files)) assert.equal(Buffer.from(bytes).toString(),'%PDF-fixture');
    },async()=>{calls++;return Buffer.from('%PDF-fixture');});
});

test('a failed ZIP form yields no partial archive and releases the generation slot',async()=>{
    let fail=true;const calls:string[]=[];
    await fixture(async base=>{
        const token=await login(base);
        const response=await post(base,'generate-package',packageInput(),token);
        assert.equal(response.status,422);
        assert.deepEqual(await response.json(),{error:'DC508: Invalid value',field:'dc508_13',form:'dc508'});
        assert.deepEqual(calls,['dc105','dc508']);
        fail=false;
        assert.equal((await post(base,'generate-package',packageInput(),token)).status,200);
    },async form=>{calls.push(String(form)); if(fail&&form==='dc508')throw new ExcelPdfFieldError('Invalid value','dc508_13');return Buffer.from('%PDF-fixture');});
});

test('ZIP and individual PDF generation share one slot and expiry during generation disallows download',async()=>{
    let release!:()=>void, started!:()=>void;
    const gate=new Promise<void>(resolve=>{release=resolve;});
    const active=new Promise<void>(resolve=>{started=resolve;});
    let calls=0;
    await fixture(async(base,advance)=>{
        const token=await login(base);
        const pending=post(base,'generate-package',packageInput(),token);
        await active;
        assert.equal((await post(base,'generate', {form:'dc105',values:values()},token)).status,503);
        advance(EXCEL_SESSION_MS); release();
        assert.equal((await pending).status,401);assert.equal(calls,1);
        const again=await login(base);
        assert.equal((await post(base,'generate',{form:'dc105',values:values()},again)).status,200);
    },async()=>{calls++;started();await gate;return Buffer.from('%PDF-fixture');});
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

test('editable download names retain the form prefix, PDF extension, Windows safety and server validation', () => {
    for (const form of EXCEL_FORMS) {
        const expected = form.id.toUpperCase() + ' - reviewed copy.pdf';
        assert.equal(row.downloadFilename(form.id, 'reviewed copy'), expected);
        assert.equal(row.downloadFilename(form.id, 'reviewed copy.PDF'), expected);
        assert.equal(row.downloadFilename(form.id, '  ' + expected + '  '), expected);
        assert.equal(excelPdfFilename(form.id, row.downloadFilename(form.id, expected)), expected);
        for (const name of ['', '../copy.pdf', 'copy/other.pdf', 'copy\\other.pdf', 'copy?.pdf', 'copy\u007f.pdf',
            'copy.pdf.exe', 'a'.repeat(175), form.id.toUpperCase() + ' - .pdf']) {
            assert.throws(() => row.downloadFilename(form.id, name));
        }
    }
    assert.throws(() => row.downloadFilename('dc105', 'DC508 - different form.pdf'), /different court form/);
    assert.throws(() => row.downloadFilename('unknown', 'copy.pdf'));
});

async function fixture(run: (base: string, advance: (ms: number) => void, restart: () => void) => Promise<void>, generate?: typeof generateExcelPdf, delivery: ExcelPdfDelivery | null = null, store?: () => ExcelSessionStore) {
    const saved = { ADMIN_USERNAME: process.env.ADMIN_USERNAME, ADMIN_PASSWORD: process.env.ADMIN_PASSWORD, NODE_ENV: process.env.NODE_ENV };
    Object.assign(process.env, { ADMIN_USERNAME: 'admin', ADMIN_PASSWORD: 'test-password', NODE_ENV: 'test' });
    let clock = Date.now();
    const createHandler = () => createExcelPdfHandler({ now: () => clock, generate, delivery, sessions: store?.() });
    let handler = createHandler();
    const admin = createAdminAuth();
    const server = http.createServer(async (req, res) => {
        if (await handler(req, res, new URL(req.url!, 'http://localhost').pathname)) return;
        if (await admin(req, res, '/api/protected')) res.end('protected');
    });
    server.listen(0, '127.0.0.1'); await once(server, 'listening');
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    try { await run(base, ms => { clock += ms; }, () => { handler = createHandler(); }); }
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
    const session = await response.json();
    assert.equal(session.expiresIn, EXCEL_SESSION_MS / 1000);
    return session.token;
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

test('row validation reports all mapped issues without changing cells or accepting partial values',()=>{
    const form=EXCEL_FORMS[0],headers=[...form.fields],input=form.fields.map(()=>'' as unknown);
    headers[2]='unmapped';headers.push('dc105_02');input.push('');
    input[4]='#REF!';input[6]=Number.NaN;input[8]={unexpected:true};
    const before=[...headers];
    assert.throws(()=>row.selectedFields(headers,input,[],form),(error:any)=>{
        assert.deepEqual(error.issues.map((issue:any)=>issue.code),['duplicate_column','missing_column','excel_error','invalid_number','unsupported_value']);
        assert.deepEqual(error.issues[0].columns,[1,48]);assert.deepEqual(error.issues[1].columns,[]);
        assert.deepEqual(error.issues[2].columns,[4]);return true;
    });
    assert.deepEqual(headers,before);assert.equal(input[4],'#REF!');
    for(const [index,name] of [[0,'A'],[25,'Z'],[26,'AA'],[87,'CJ'],[2047,'BZT']] as const)assert.equal(row.columnName(index),name);
    for(const index of [-1,2048,1.5,Number.NaN])assert.throws(()=>row.columnName(index));
});

test('Office validation errors include the source sheet, row and header or value columns',async()=>{
    const fixture=officeFixture();
    fixture.state.headers[fixture.state.headers.indexOf('dc105_03')]='unmapped';
    fixture.state.values[fixture.state.headers.indexOf('dc105_05')]='#REF!';
    await assert.rejects(workbook.readSelection(fixture.excel,fixture.form,{sleep:fixture.sleep}),(error:any)=>{
        assert.deepEqual(error.source,{sheet:'Working Document',sheetId:'sheet-1',row:36});
        assert.equal(error.issues.length,2);assert.equal(error.issues[1].field,'dc105_05');
        assert.deepEqual(error.issues[1].columns,[fixture.state.headers.indexOf('dc105_05')]);return true;
    });
    const metadata=officeFixture();metadata.state.headers.push('Defendant');metadata.state.values.push('Other person');metadata.state.width++;
    await assert.rejects(workbook.readSelection(metadata.excel,metadata.form,{sleep:metadata.sleep}),(error:any)=>{
        assert.equal(error.issues[0].field,'Defendant');assert.equal(error.issues[0].code,'duplicate_column');
        assert.equal(error.source.row,36);return true;
    });
});

test('source-cell navigation only activates and selects the exact worksheet cell',async()=>{
    const operations:unknown[]=[];
    const excel={run:async(callback:any)=>callback({workbook:{worksheets:{getItem(id:string){operations.push(['sheet',id]);return {
        activate(){operations.push(['activate']);},getRangeByIndexes(...indexes:number[]){operations.push(['range',...indexes]);return {
            select(){operations.push(['select']);}};}};}}},sync:async()=>{operations.push(['sync']);}})};
    await workbook.selectSource(excel,{sheetId:'sheet-1',row:36,column:87});
    assert.deepEqual(operations,[['sheet','sheet-1'],['activate'],['range',35,87,1,1],['select'],['sync']]);
    for(const bad of [{row:0},{row:1048577},{column:-1},{column:2048},{sheetId:''},{row:1.5}]){
        await assert.rejects(workbook.selectSource(excel,{sheetId:'sheet-1',row:36,column:87,...bad}),/source cell/);
    }
    assert.equal(operations.length,5);
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
    const expired = await login(base); advance(EXCEL_SESSION_MS - 1);
    assert.equal((await post(base, 'resume', {}, expired)).status, 200);
    advance(1);
    assert.equal((await post(base, 'generate', { form: 'dc105', values: values() }, expired)).status, 401);
    const changed = await login(base); process.env.ADMIN_PASSWORD = 'new-password';
    assert.equal((await post(base, 'generate', { form: 'dc105', values: values() }, changed)).status, 401);
}, async () => Buffer.from('%PDF-fixture')));

test('Excel resume verifies access without refreshing the 12-hour deadline or accepting another device on the same IP', async () => fixture(async (base, advance) => {
    const token = await login(base);
    const first = await (await post(base, 'resume', {}, token)).json();
    advance(6 * 60 * 60_000);
    const resumed = await (await post(base, 'resume', {}, token)).json();
    assert.equal(resumed.expiresAt, first.expiresAt);
    assert.equal(resumed.expiresIn, 6 * 60 * 60);
    assert.equal((await post(base, 'resume', {})).status, 401);
    assert.equal((await post(base, 'resume', {}, token, 'https://untrusted.example')).status, 403);
    assert.equal((await post(base, 'resume', {}, 'a'.repeat(64))).status, 401);
    advance(6 * 60 * 60_000);
    assert.equal((await post(base, 'resume', {}, token)).status, 401);
}));

test('Excel client remembers only a scoped token and expiry, handles disabled storage, and clears invalid sessions', () => {
    let clock = Date.now();
    const values = new Map<string, string>();
    const storage = {getItem: (key: string) => values.get(key) || null,
        setItem: (key: string, value: string) => { values.set(key, value); }, removeItem: (key: string) => { values.delete(key); }};
    const first = clientSessions.create(storage, () => clock), token = 'a'.repeat(64);
    first.write(token, EXCEL_SESSION_MS / 1000);
    const second = clientSessions.create(storage, () => clock);
    assert.deepEqual(second.read(), {token, expiresAt: clock + EXCEL_SESSION_MS});
    assert.deepEqual(Object.keys(JSON.parse(values.get(clientSessions.KEY)!)), ['token', 'expiresAt']);
    clock += EXCEL_SESSION_MS;
    assert.equal(second.read(), null); assert.equal(values.size, 0);
    for (const invalid of ['{', JSON.stringify({token, expiresAt: clock + EXCEL_SESSION_MS + 2000}), JSON.stringify({token:'bad', expiresAt:clock + 1000})]) {
        values.set(clientSessions.KEY, invalid);
        assert.equal(clientSessions.create(storage, () => clock).read(), null);
    }
    for (const blocked of [undefined, {getItem(){throw Error();},setItem(){throw Error();},removeItem(){throw Error();}},
        {getItem(){return null;},setItem(){throw Error();},removeItem(){}}]) {
        const memory = clientSessions.create(blocked, () => clock);
        memory.write(token, 3600); assert.equal(memory.read().token, token);
        memory.clear(); assert.equal(memory.read(), null);
    }
    assert.throws(() => first.write(token, 13 * 60 * 60));
    first.write(token, 3600); first.clear(); assert.equal(second.read(), null);
});

test('SQLite Excel sessions survive restart, store no reusable token or password, and remain separate from admin access', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'excel-session-qa-'));
    const filename = path.join(directory, 'workflow.sqlite');
    let db = new WorkflowDatabase(filename);
    try {
        await fixture(async (base, advance, restart) => {
            const token = await login(base);
            const hash = createHash('sha256').update(token).digest('hex');
            const inspection = new DatabaseSync(filename, {readOnly:true});
            try {
                const rows = inspection.prepare('SELECT * FROM excel_sessions').all();
                assert.equal(rows.length, 1); assert.equal(rows[0].token_hash, hash);
                assert.ok(!JSON.stringify(rows).includes(token)); assert.ok(!JSON.stringify(rows).includes('test-password'));
                assert.equal(inspection.prepare('SELECT COUNT(*) AS n FROM admin_sessions').get()!.n, 0);
            } finally { inspection.close(); }
            const reboot = () => { db.close(); db = new WorkflowDatabase(filename); restart(); };
            reboot();
            assert.equal((await post(base, 'resume', {}, token)).status, 200);
            assert.equal((await post(base, 'generate', {form:'dc105', values:values()}, token)).status, 200);
            assert.equal((await post(base, 'resume', {}, hash)).status, 401);
            assert.equal((await fetch(base + '/api/protected', {headers:{Cookie:'legal_admin_session=' + token}})).status, 401);
            await post(base, 'logout', {}, token); reboot();
            assert.equal((await post(base, 'resume', {}, token)).status, 401);
            const expired = await login(base); advance(EXCEL_SESSION_MS); reboot();
            assert.equal((await post(base, 'resume', {}, expired)).status, 401);
            const revoked = await login(base); process.env.ADMIN_PASSWORD = 'changed-password'; reboot();
            assert.equal((await post(base, 'resume', {}, revoked)).status, 401);
            process.env.ADMIN_PASSWORD = 'test-password'; reboot();
            assert.equal((await post(base, 'resume', {}, revoked)).status, 401);
        }, async () => Buffer.from('%PDF-fixture'), null, () => db.getExcelSessionStore());
    } finally { db.close(); fs.rmSync(directory, {recursive:true, force:true}); }
});

test('Excel shell supports Office framing but never exposes templates or general admin sessions', async () => fixture(async base => {
    const shell = await fetch(base + '/excel/');
    assert.equal(shell.status, 200);
    const csp = shell.headers.get('content-security-policy')!;
    assert.ok(csp.includes('https://appsforoffice.microsoft.com'));
    assert.ok(csp.includes('https://*.officeapps.live.com'));
    assert.ok(csp.includes('https://onedrive.live.com'));
    assert.ok(!csp.includes('https://*.live.com'));
    assert.equal(shell.headers.get('x-frame-options'),null);
    assert.ok(!csp.includes('unsafe-inline'));
    for (const asset of ['app.js', 'row.js', 'workbook.js', 'session.js', 'commands.html', 'commands.js', 'style.css', 'icon.png', 'icon-16.png', 'icon-32.png', 'icon-80.png', 'lucide.js', 'catalog', 'manifest.xml', 'pdfjs/pdf.mjs', 'pdfjs/pdf.worker.mjs']) assert.equal((await fetch(base + '/excel/' + asset)).status, 200);
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
    for (const filename of ['../DC105.pdf', 'DC105 - a/b.pdf', 'DC105 - a\\b.pdf', 'DC508 - Other.pdf', 'DC105 - X.pdf.exe', 'DC105 - trailing.pdf ', 'DC105 - .pdf', 'DC105 - trailing .pdf', 'DC105 - invalid\u007f.pdf', 'DC105 - ' + 'a'.repeat(180) + '.pdf']) {
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
const pythonAvailable = spawnSync(python, ['-c', 'import pypdf,openpyxl,reportlab'], { windowsHide: true }).status === 0;
test('the Python PDF quality suite runs with the normal project regression', { skip:!pythonAvailable }, () => {
    const result=spawnSync(python,['-m','unittest','discover','-s',path.resolve(__dirname,'../tools/excel_pdf'),'-p','test_core.py','-v'],
        {windowsHide:true,timeout:30_000});
    assert.equal(result.status,0,result.stderr.toString());
});
test('field validation errors retain the field identifier without returning a partial PDF', async () => fixture(async base => {
    const response = await post(base, 'generate', { form:'dc105', values:values() }, await login(base));
    assert.equal(response.status,422);
    assert.deepEqual(await response.json(),{error:'Text is too long.',field:'dc105_06'});
    assert.equal(response.headers.has('x-excel-generation-id'),false);
},async()=>{throw new ExcelPdfFieldError('Text is too long.','dc105_06');}));

test('the isolated PDF worker rejects clipped text with an actionable field error and recovers', { skip:!pythonAvailable }, async () => {
    for (const input of [{dc105_06:'W'.repeat(100)},{dc105_06:'First\nSecond'},{dc105_19:true}]) {
        await assert.rejects(generateExcelPdf('dc105',{...values(),...input},python),error=>{
            assert.ok(error instanceof ExcelPdfFieldError);
            assert.equal(error.field,Object.keys(input)[0]);
            assert.ok(!error.message.startsWith('{'));
            return true;
        });
    }
    const pdf=await generateExcelPdf('dc105',{...values(),dc105_06:'Corrected Tenant'},python);
    assert.ok(pdf.subarray(0,5).equals(Buffer.from('%PDF-')));
});

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

test('ZIP contains three independently readable fillable PDFs, 101 fields and four pages without cloud writes',
    {skip:!pythonAvailable && 'Set EXCEL_PDF_PYTHON'}, async()=>fixture(async base=>{
        const token=await login(base),input=packageInput();
        const fields={dc105:'dc105_05',dc508:'dc508_06',mc202:'mc202_08'};
        for(const item of input.forms)item.values[fields[item.form as keyof typeof fields]]='Fictional ZIP LLC';
        const response=await post(base,'generate-package',input,token);
        assert.equal(response.status,200);
        const archive=Buffer.from(await response.arrayBuffer());
        const check=spawnSync(python,['-c',
            'import sys,io,json,zipfile; from pypdf import PdfReader; z=zipfile.ZipFile(io.BytesIO(sys.stdin.buffer.read())); assert z.testzip() is None; result=[]\nfor name in z.namelist():\n r=PdfReader(io.BytesIO(z.read(name))); f=r.get_fields(); widgets=[a.get_object() for p in r.pages for a in p.get("/Annots",[]) if a.get_object().get("/Subtype")=="/Widget"]; assert all(a.get("/AP") for a in widgets); result.append({"name":name,"fields":len(f),"widgets":len(widgets),"pages":len(r.pages),"values":[str(v.get("/V")) for v in f.values() if str(v.get("/V"))=="Fictional ZIP LLC"]})\nprint(json.dumps(result))'],
            {input:archive,windowsHide:true});
        assert.equal(check.status,0,check.stderr.toString());
        const result=JSON.parse(check.stdout.toString());
        assert.equal(result.length,3);
        assert.equal(result.reduce((n:number,item:any)=>n+item.fields,0),101);
        assert.equal(result.reduce((n:number,item:any)=>n+item.pages,0),4);
        for(const item of result){assert.ok(item.widgets>=item.fields);assert.deepEqual(item.values,['Fictional ZIP LLC']);}
        assert.equal(response.headers.has('x-excel-generation-id'),false);
        assert.deepEqual(await (await post(base,'delivery',{},token)).json(),{available:false});
    }));
