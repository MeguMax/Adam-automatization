import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { chromium } from 'playwright';
import { createExcelPdfHandler, EXCEL_FORMS } from './excelPdf';

async function main() {
    const output = path.resolve('output/excel-addin-qa');
    fs.mkdirSync(output, { recursive: true });
    process.env.ADMIN_USERNAME = 'excel-qa'; process.env.ADMIN_PASSWORD = 'excel-qa-only';
    process.env.NODE_ENV = 'test';
    const savedCopies: { name: string; hash: string }[] = [];
    let deliveryFails = false;
    const handler = createExcelPdfHandler({ delivery:{
        destination:async()=>({name:'Fictional QA Forms'}),
        save:async(name,pdf)=>{
            if(deliveryFails) throw new Error('OneDrive test outage. Retry saving.');
            savedCopies.push({name,hash:createHash('sha256').update(pdf).digest('hex')});
            return {name,url:'https://example.sharepoint.com/forms/fictional.pdf'};
        },
    } });
    const server = http.createServer(async (req, res) => {
        if (!await handler(req, res, new URL(req.url!, 'http://localhost').pathname)) { res.statusCode = 404; res.end(); }
    });
    server.listen(0, '127.0.0.1'); await once(server, 'listening');
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const browser = await chromium.launch({ headless: true });
    try {
        const page = await browser.newPage({ viewport: { width: 380, height: 850 } });
        const headers = ['Defendant','Landlord','Court_Name','Case_Number', ...EXCEL_FORMS.flatMap(form => form.fields)];
        const values = headers.map(header => header === 'Defendant' ? 'Morgan Tenant' : header === 'Landlord' ? 'Example Property LLC' :
            header === 'Court_Name' ? '29th' : header === 'Case_Number' ? '26-00001-LT' :
            ['dc105_05','dc508_06','mc202_08'].includes(header) ? 'Example Property LLC' :
            ['dc105_06','dc508_08','mc202_10'].includes(header) ? 'Morgan Tenant' :
            ['dc105_02','dc508_02','mc202_04'].includes(header) ? '26-00001-LT' : header === 'dc105_24' ? 46300 : '');
        const fake = `window.qa = ${JSON.stringify({ headers, values, rowIndex: 35, rowCount: 1 })};
window.qa.events = []; window.qa.calculations = 0; window.qa.pending = 0;
const event = {add: callback => {if(!qa.disableEvents) window.qa.events.push(callback)}};
const sheet = {id:'sheet-1',get name(){return qa.sheetName || 'Working Document'},load(){return this},
 getUsedRange(){return {columnIndex:0,columnCount:qa.headers.length,load(){return this}}},
 getRangeByIndexes(row){return {get values(){return [row===0?qa.headers:qa.values]},get valueTypes(){return [qa.values.map(x=>typeof x==='number'?'Double':'String')]},load(){return this},getCell(){return {isDate:true}}}}};
window.Excel = {CalculationType:{recalculate:'Recalculate'},CalculationState:{done:'Done'},run:async callback=>callback({sync:async()=>{},application:{get calculationState(){if(qa.pending>0){qa.pending--;return 'Calculating'} return 'Done'},calculate(){qa.calculations++;for(const field of ['dc105_05','dc508_06','mc202_08']) qa.values[qa.headers.indexOf(field)]=qa.values[qa.headers.indexOf('Landlord')];for(const field of ['dc105_06','dc508_08','mc202_10']) qa.values[qa.headers.indexOf(field)]=qa.values[qa.headers.indexOf('Defendant')];},load(){}},workbook:{
 getSelectedRange(){return {rowIndex:qa.rowIndex,rowCount:qa.rowCount,worksheet:sheet,load(){return this}}},
 worksheets:{onChanged:event,onSelectionChanged:event,onActivated:event,onAdded:event,onDeleted:event},
 functions:{text(){return {value:qa.date || '10/5/2026',load(){return this}}}}
}})};
window.Office = {HostType:{Excel:'Excel'},context:{requirements:{isSetSupported:(_api,version)=>version==='1.9'&&!qa.unsupported}},onReady:callback=>Promise.resolve().then(()=>callback({host:'Excel'}))};`;
        const errors: string[] = [];
        page.on('pageerror', error => errors.push(error.message));
        await page.route('**/*', async route => {
            if (route.request().url().startsWith('https://appsforoffice.microsoft.com/')) await route.fulfill({ contentType: 'text/javascript', body: fake });
            else if (route.request().url().startsWith(base)) await route.continue();
            else await route.abort();
        });
        await page.goto(base + '/excel/');
        await page.screenshot({ path: path.join(output, 'sign-in.png') });
        await page.fill('#username', 'excel-qa'); await page.fill('#password', 'excel-qa-only'); await page.click('#login');
        await page.waitForFunction(() => document.getElementById('caseName')?.textContent === 'Morgan Tenant');
        await page.waitForSelector('#deliveryOptions:visible');
        assert.equal(await page.locator('#autoSave').isChecked(),false);
        await page.screenshot({ path: path.join(output, 'selected-row.png') });
        for (const form of EXCEL_FORMS) {
            await page.selectOption('#form', form.id);
            const request = page.waitForRequest(req => req.url().endsWith('/excel/generate'));
            await page.click('#generate');
            const payload = (await request).postDataJSON();
            assert.equal(Object.keys(payload.values).length, form.count);
            if (form.id === 'dc105') assert.equal(payload.values.dc105_24, '10/5/2026');
            await page.waitForFunction(() => document.getElementById('status')?.textContent?.includes('Fillable fields retained'));
            assert.equal(await page.locator('#preview canvas').count(), form.pages);
            const nonblank = await page.locator('#preview canvas').first().evaluate((element: HTMLCanvasElement) => {
                const pixels = element.getContext('2d')!.getImageData(0, 0, element.width, element.height).data;
                let dark = 0; for (let index = 0; index < pixels.length; index += 4) if (pixels[index] < 180 && pixels[index + 3] > 0) dark++;
                return dark > 100;
            });
            assert.equal(nonblank, true);
            const downloadEvent = page.waitForEvent('download'); await page.click('#save');
            const download = await downloadEvent;
            assert.equal(download.suggestedFilename(), form.id.toUpperCase() + ' - 29th - 26-00001-LT - Example Property LLC v Morgan Tenant.pdf');
            await download.saveAs(path.join(output, download.suggestedFilename()));
            await page.screenshot({ path: path.join(output, form.id + '-mobile.png'), fullPage: true });
        }
        // A new form/edited formula must not require reopening Office or logging in again.
        await page.click('#back');
        assert.equal(await page.locator('#result').isVisible(),false);
        assert.equal(await page.locator('#signIn').isVisible(),false);
        await page.evaluate(()=>{
            const qa=(window as any).qa;qa.values[qa.headers.indexOf('Landlord')]='Updated Example LLC';qa.events[1]();
        });
        await page.waitForFunction(()=>!(document.getElementById('generate') as HTMLButtonElement).disabled);
        const editedRequest=page.waitForRequest(request=>request.url().endsWith('/excel/generate'));
        await page.click('#generate');
        assert.equal((await editedRequest).postDataJSON().values.mc202_08,'Updated Example LLC');
        await page.waitForFunction(()=>document.getElementById('status')?.textContent?.includes('Fillable fields retained'));
        const editedDownloadEvent=page.waitForEvent('download');await page.click('#save');
        const editedDownload=await editedDownloadEvent;
        const editedPath=path.join(output,editedDownload.suggestedFilename());await editedDownload.saveAs(editedPath);
        const editedCheck=spawnSync(process.env.EXCEL_PDF_PYTHON||'python3',['-c',
            'import sys; from pypdf import PdfReader; assert PdfReader(sys.argv[1]).get_fields()["mc202_08"]["/V"] == "Updated Example LLC"',editedPath],{windowsHide:true});
        assert.equal(editedCheck.status,0,editedCheck.stderr.toString());
        await page.click('#saveCloud');
        await page.waitForFunction(()=>document.getElementById('status')?.textContent?.includes('saved to OneDrive'));
        assert.equal(savedCopies.length,1);assert.equal(savedCopies[0].name,editedDownload.suggestedFilename());
        assert.equal(savedCopies[0].hash,createHash('sha256').update(fs.readFileSync(editedPath)).digest('hex'));
        assert.equal(await page.locator('#saveCloud').isDisabled(),true);
        assert.equal(await page.locator('#openCloud').getAttribute('href'),'https://example.sharepoint.com/forms/fictional.pdf');
        await page.check('#autoSave');deliveryFails=true;
        await page.click('#generate');
        await page.waitForFunction(()=>document.getElementById('error')?.textContent?.includes('OneDrive test outage'));
        assert.equal(await page.locator('#result').isVisible(),true);assert.equal(await page.locator('#saveCloud').isEnabled(),true);
        deliveryFails=false;await page.click('#saveCloud');
        await page.waitForFunction(()=>document.getElementById('status')?.textContent?.includes('saved to OneDrive'));
        assert.equal(savedCopies.length,2);
        await page.click('#generate');
        await page.waitForFunction(()=>document.getElementById('status')?.textContent?.includes('saved to OneDrive'));
        assert.equal(savedCopies.length,3);
        await page.uncheck('#autoSave');
        await page.click('#generate');
        await page.waitForFunction(()=>document.getElementById('status')?.textContent?.includes('Fillable fields retained'));
        await page.evaluate(()=>{const qa=(window as any).qa;qa.values[qa.headers.indexOf('mc202_08')]='Stale without an event';});
        await page.click('#saveCloud');
        await page.waitForFunction(()=>document.getElementById('error')?.textContent?.includes('changed since this PDF'));
        assert.equal(savedCopies.length,3);assert.equal(await page.locator('#result').isVisible(),false);
        await page.setViewportSize({ width: 340, height: 450 });
        await page.click('#generate');
        await page.waitForFunction(() => document.getElementById('status')?.textContent?.includes('Fillable fields retained'));
        await page.waitForFunction(() => {
            const result = document.querySelector('#result h2')!.getBoundingClientRect();
            const save = document.getElementById('save')!.getBoundingClientRect();
            const cloud=document.getElementById('cloudActions')!.getBoundingClientRect();
            return result.top >= 0 && save.bottom <= innerHeight && cloud.bottom <= innerHeight;
        });
        await page.screenshot({ path:path.join(output,'generated-short-taskpane.png') });
        await page.setViewportSize({ width: 900, height: 900 });
        await page.waitForFunction(() => (document.querySelector('#preview canvas') as HTMLCanvasElement)?.width > 600);
        await page.screenshot({ path: path.join(output, 'generated-desktop.png'), fullPage: true });
        await page.evaluate(() => { const qa = (window as any).qa; qa.rowCount = 2; qa.events[0](); });
        await page.waitForFunction(() => document.getElementById('error')?.textContent?.includes('multiple rows'));
        assert.equal(await page.locator('#result').isVisible(), false);
        await page.evaluate(() => { const qa = (window as any).qa; qa.rowCount = 1; qa.rowIndex = 53; qa.values[0] = 'Second Tenant'; qa.events[0](); });
        await page.waitForFunction(()=>!(document.getElementById('generate') as HTMLButtonElement).disabled);
        await page.click('#generate');
        await page.waitForFunction(() => document.getElementById('status')?.textContent?.includes('Fillable fields retained'));
        assert.ok((await page.locator('#resultName').innerText()).includes('Updated Example LLC v Second Tenant.pdf'));
        await page.route('**/excel/generate', async route => { await new Promise(resolve => setTimeout(resolve, 250)); await route.continue(); });
        const pending = page.waitForRequest(req => req.url().endsWith('/excel/generate'));
        await page.click('#generate'); await pending;
        await page.evaluate(() => { const qa = (window as any).qa; qa.values[0] = 'Third Tenant'; qa.events[0](); });
        await page.waitForFunction(() => document.getElementById('error')?.textContent?.includes('worksheet changed'));
        assert.equal(await page.locator('#result').isVisible(), false);
        await page.unroute('**/excel/generate');
        // Silent formula changes must be caught even if Office event delivery is unavailable.
        await page.waitForFunction(()=>!(document.getElementById('generate') as HTMLButtonElement).disabled);
        const slow = page.waitForRequest(req=>req.url().endsWith('/excel/generate'));
        await page.route('**/excel/generate', async route => { await new Promise(resolve=>setTimeout(resolve,250));await route.continue(); });
        await page.click('#generate');await slow;
        await page.evaluate(()=>{const qa=(window as any).qa;qa.values[qa.headers.indexOf('mc202_05')]='Changed without an event';});
        await page.waitForFunction(()=>document.getElementById('error')?.textContent?.includes('worksheet changed'));
        assert.equal(await page.locator('#result').isVisible(),false);
        await page.unroute('**/excel/generate');
        await page.waitForFunction(()=>!(document.getElementById('generate') as HTMLButtonElement).disabled);
        await page.evaluate(()=>{(window as any).qa.pending=4;});
        await page.click('#generate');
        await page.waitForFunction(()=>document.getElementById('status')?.textContent?.includes('Fillable fields retained'));
        assert.equal(await page.locator('#result').isVisible(),true);
        let unexpectedDownload = false;
        const rejectDownload = () => {unexpectedDownload=true;};
        page.on('download',rejectDownload);
        await page.evaluate(()=>{const qa=(window as any).qa;qa.values[qa.headers.indexOf('mc202_05')]='Edited after preview';});
        await page.click('#save');
        await page.waitForFunction(()=>document.getElementById('error')?.textContent?.includes('changed since this PDF'));
        assert.equal(unexpectedDownload,false);
        assert.equal(await page.locator('#result').isVisible(),false);
        page.off('download',rejectDownload);
        await page.evaluate(()=>{const qa=(window as any).qa;qa.sheetName='New case worksheet';qa.rowIndex=3;qa.events[3]();});
        await page.waitForFunction(()=>document.getElementById('selection')?.textContent?.includes('New case worksheet / Row 4'));
        for (const failure of ['html-error', 'network', 'wrong-type', 'invalid-pdf']) {
            await page.route('**/excel/generate', async route => {
                if (failure === 'network') await route.abort('failed');
                else await route.fulfill({status:failure === 'html-error' ? 502 : 200,
                    contentType:failure === 'invalid-pdf' ? 'application/pdf' : 'text/html', body:'<html>Not a PDF</html>'});
            });
            await page.click('#generate');
            const expected = failure === 'html-error' ? 'temporarily unavailable' : failure === 'network' ? 'Could not reach' : failure === 'wrong-type' ? 'unexpected response' : 'PDF is invalid';
            await page.waitForFunction(text=>document.getElementById('error')?.textContent?.includes(text), expected);
            assert.equal(await page.locator('#generate').isEnabled(), true);
            assert.equal(await page.locator('#result').isVisible(), false);
            await page.unroute('**/excel/generate');
        }
        await page.clock.install();
        let release: (() => void) | undefined;
        await page.route('**/excel/generate', route => new Promise<void>(resolve => {
            release = () => { route.abort().catch(() => {}).finally(resolve); };
        }));
        const stalled = page.waitForRequest(req=>req.url().endsWith('/excel/generate'));
        await page.click('#generate'); await stalled;
        await page.clock.fastForward(45_001);
        await page.clock.resume();
        await page.waitForFunction(()=>document.getElementById('error')?.textContent?.includes('request timed out'));
        release!(); await page.unroute('**/excel/generate');
        assert.equal(await page.locator('#generate').isEnabled(), true);
        await page.click('#generate');
        await page.waitForFunction(()=>document.getElementById('status')?.textContent?.includes('Fillable fields retained'));
        const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth);
        assert.equal(overflow, false);
        assert.equal(await page.evaluate(() => localStorage.length), 0);
        await page.click('#logout'); await page.waitForSelector('#signIn:visible');
        assert.equal(await page.locator('#password').inputValue(), '');
        assert.equal(await page.locator('#autoSave').isChecked(),false);
        const previousSaves=savedCopies.length;
        await page.route('**/excel/delivery',route=>route.fulfill({contentType:'application/json',body:JSON.stringify({available:false})}));
        await page.fill('#username','excel-qa');await page.fill('#password','excel-qa-only');await page.click('#login');
        await page.waitForFunction(()=>!(document.getElementById('generate') as HTMLButtonElement).disabled);
        assert.equal(await page.locator('#deliveryOptions').isVisible(),false);
        await page.setViewportSize({width:340,height:450});await page.click('#generate');
        await page.waitForFunction(()=>document.getElementById('status')?.textContent?.includes('Fillable fields retained'));
        assert.equal(await page.locator('#cloudActions').isVisible(),false);assert.equal(savedCopies.length,previousSaves);
        await page.screenshot({path:path.join(output,'download-only-short-taskpane.png')});
        await page.click('#logout');await page.waitForSelector('#signIn:visible');
        assert.equal(await page.evaluate(()=>sessionStorage.length),0);
        assert.deepEqual(errors, []);
        console.log('Excel task-pane smoke passed with an explicit simulated Excel 1.9 host: fillable downloads, edited-formula PDF readback without relogin, manual/automatic OneDrive adapter saves, exact saved-byte hashes, failed-save retry, stale-save rejection, responsive previews, calculation/change guards, network errors and logout. Cloud storage was simulated; no real OneDrive uploads.');
    } finally {
        await browser.close();
        await new Promise<void>(resolve => { server.close(() => resolve()); server.closeIdleConnections(); });
    }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
