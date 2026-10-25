import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { once } from 'node:events';
import { chromium } from 'playwright';
import { createExcelPdfHandler, EXCEL_FORMS } from './excelPdf';

async function main() {
    const output = path.resolve('output/excel-addin-qa');
    fs.mkdirSync(output, { recursive: true });
    process.env.ADMIN_USERNAME = 'excel-qa'; process.env.ADMIN_PASSWORD = 'excel-qa-only';
    process.env.NODE_ENV = 'test';
    const handler = createExcelPdfHandler();
    const server = http.createServer(async (req, res) => {
        if (!await handler(req, res, new URL(req.url!, 'http://localhost').pathname)) { res.statusCode = 404; res.end(); }
    });
    server.listen(0, '127.0.0.1'); await once(server, 'listening');
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const browser = await chromium.launch({ headless: true });
    try {
        const page = await browser.newPage({ viewport: { width: 380, height: 850 } });
        const headers = ['Defendant', ...EXCEL_FORMS.flatMap(form => form.fields)];
        const values = headers.map(header => header === 'Defendant' ? 'Morgan Tenant' : header === 'dc105_05' ? 'Example Property LLC' : header === 'dc105_06' ? 'Morgan Tenant' : header === 'dc105_24' ? 46300 : '');
        const fake = `window.qa = ${JSON.stringify({ headers, values, rowIndex: 35, rowCount: 1 })};
window.qa.events = [];
const event = {add: callback => window.qa.events.push(callback)};
const sheet = {name:'Working Document',load(){return this},onChanged:event,onSelectionChanged:event,onActivated:event,
 getUsedRange(){return {columnIndex:0,columnCount:qa.headers.length,load(){return this}}},
 getRangeByIndexes(row){return {get values(){return [row===0?qa.headers:qa.values]},get valueTypes(){return [qa.values.map(x=>typeof x==='number'?'Double':'String')]},load(){return this},getCell(){return {isDate:true}}}}};
window.Excel = {CalculationType:{recalculate:'Recalculate'},CalculationState:{done:'Done'},run:async callback=>callback({sync:async()=>{},application:{calculationState:'Done',calculate(){},load(){}},workbook:{
 getSelectedRange(){return {get rowIndex(){return qa.rowIndex},get rowCount(){return qa.rowCount},worksheet:sheet,load(){return this}}},worksheets:{items:[sheet],load(){}},functions:{text(){return {value:'10/5/2026',load(){return this}}}}
}})};
window.Office = {HostType:{Excel:'Excel'},context:{requirements:{isSetSupported:()=>true}},onReady:callback=>Promise.resolve().then(()=>callback({host:'Excel'}))};`;
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
            assert.equal(download.suggestedFilename(), form.id.toUpperCase() + '-row-36.pdf');
            await download.saveAs(path.join(output, download.suggestedFilename()));
            await page.screenshot({ path: path.join(output, form.id + '-mobile.png'), fullPage: true });
        }
        await page.setViewportSize({ width: 900, height: 900 });
        await page.waitForFunction(() => (document.querySelector('#preview canvas') as HTMLCanvasElement)?.width > 600);
        await page.screenshot({ path: path.join(output, 'generated-desktop.png'), fullPage: true });
        await page.evaluate(() => { const qa = (window as any).qa; qa.rowCount = 2; qa.events[0](); });
        await page.waitForFunction(() => document.getElementById('error')?.textContent?.includes('multiple rows'));
        assert.equal(await page.locator('#result').isVisible(), false);
        await page.evaluate(() => { const qa = (window as any).qa; qa.rowCount = 1; qa.rowIndex = 53; qa.values[0] = 'Second Tenant'; });
        await page.click('#generate');
        await page.waitForFunction(() => document.getElementById('status')?.textContent?.includes('Fillable fields retained'));
        assert.ok((await page.locator('#resultName').innerText()).includes('Second Tenant / MC202-row-54.pdf'));
        await page.route('**/excel/generate', async route => { await new Promise(resolve => setTimeout(resolve, 250)); await route.continue(); });
        const pending = page.waitForRequest(req => req.url().endsWith('/excel/generate'));
        await page.click('#generate'); await pending;
        await page.evaluate(() => { const qa = (window as any).qa; qa.values[0] = 'Third Tenant'; qa.events[0](); });
        await page.waitForFunction(() => document.getElementById('error')?.textContent?.includes('worksheet changed'));
        assert.equal(await page.locator('#result').isVisible(), false);
        await page.unroute('**/excel/generate');
        const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth);
        assert.equal(overflow, false);
        assert.equal(await page.evaluate(() => localStorage.length), 0);
        await page.click('#logout'); await page.waitForSelector('#signIn:visible');
        assert.equal(await page.locator('#password').inputValue(), '');
        assert.deepEqual(errors, []);
        console.log('Excel task-pane smoke passed with an explicit simulated Office host: login, selected row, 3 real PDF downloads, nonblank PDF.js previews, date formatting boundary, changed selection during generation, multi-row guard, logout and responsive layouts.');
    } finally {
        await browser.close();
        await new Promise<void>(resolve => { server.close(() => resolve()); server.closeIdleConnections(); });
    }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
