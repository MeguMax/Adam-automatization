import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { chromium } from 'playwright';
import { createExcelPdfHandler, EXCEL_FORMS, generateExcelPdf } from './excelPdf';

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
 functions:Object.fromEntries(['month','day','year'].map((name,index)=>[name,()=>({value:Number((qa.date || '10/5/2026').split('/')[index]),load(){return this}})]))
}})};
window.Office = {HostType:{Excel:'Excel'},context:{requirements:{isSetSupported:(_api,version)=>version==='1.9'&&!qa.unsupported}},onReady:callback=>Promise.resolve().then(()=>callback({host:'Excel'}))};`;
        const errors: string[] = [];
        page.on('pageerror', error => errors.push(error.message));
        await page.route('**/*', async route => {
            if (route.request().url().startsWith('https://appsforoffice.microsoft.com/')) await route.fulfill({ contentType: 'text/javascript', body: fake });
            else if (route.request().url().startsWith(base)) await route.continue();
            else await route.abort();
        });
        // Exercise real browser ancestor checks without contacting Microsoft or a live workbook.
        const framedPage = await browser.newPage();
        const qaPaneOrigin = 'https://devlin-excel.example.test';
        await framedPage.route('**/*', async route => {
            const url = route.request().url();
            if (url === 'https://onedrive.live.com/devlin-qa') {
                await route.fulfill({contentType:'text/html',body:'<iframe src="https://excel.officeapps.live.com/devlin-qa"></iframe>'});
            } else if (url === 'https://excel.officeapps.live.com/devlin-qa') {
                await route.fulfill({contentType:'text/html',body:'<iframe src="'+qaPaneOrigin+'/excel/"></iframe>'});
            } else if (url.startsWith(qaPaneOrigin+'/')) {
                const source = await route.fetch({url:base+new URL(url).pathname});
                await route.fulfill({response:source});
            } else if (url.startsWith('https://appsforoffice.microsoft.com/')) {
                await route.fulfill({contentType:'text/javascript',body:fake});
            } else await route.abort();
        });
        await framedPage.goto('https://onedrive.live.com/devlin-qa');
        await framedPage.frameLocator('iframe').frameLocator('iframe').getByRole('heading',{name:'Connect Excel',exact:true}).waitFor({state:'visible'});
        await framedPage.close();
        await page.goto(base + '/excel/');
        await page.screenshot({ path: path.join(output, 'sign-in.png') });
        let loginRequests = 0;
        page.on('request', request => { if (request.url() === base + '/excel/session') loginRequests++; });
        await page.fill('#username', 'excel-qa'); await page.fill('#password', 'excel-qa-only'); await page.click('#login');
        await page.waitForFunction(() => document.getElementById('caseName')?.textContent === 'Morgan Tenant');
        await page.waitForSelector('#deliveryOptions:visible');
        assert.equal(await page.locator('#autoSave').isChecked(),false);
        const remembered = await page.evaluate(() => JSON.parse(localStorage.getItem('devlin.excel.session.v1')!));
        assert.deepEqual(Object.keys(remembered), ['token', 'expiresAt']);
        assert.ok(remembered.expiresAt > Date.now() + 11 * 60 * 60_000);
        await page.reload();
        await page.waitForFunction(() => !(document.getElementById('generate') as HTMLButtonElement).disabled);
        assert.equal(await page.locator('#signIn').isVisible(), false);
        assert.equal(loginRequests, 1);
        assert.equal(await page.locator('#password').inputValue(), '');
        await page.goto('about:blank'); await page.goto(base + '/excel/');
        await page.waitForFunction(() => !(document.getElementById('generate') as HTMLButtonElement).disabled);
        assert.equal(loginRequests, 1);
        // A temporary outage must retain the saved session, not ask for another password.
        await page.route('**/excel/resume', route => route.fulfill({status:502,contentType:'text/html',body:'Gateway unavailable'}));
        await page.reload();
        await page.waitForFunction(() => document.getElementById('error')?.textContent?.includes('temporarily unavailable'));
        assert.equal(await page.locator('#signIn').isVisible(), false);
        assert.equal(await page.locator('#connection').isVisible(), true);
        assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('devlin.excel.session.v1')!).token), remembered.token);
        await page.screenshot({path:path.join(output,'reconnect-outage.png')});
        await page.unroute('**/excel/resume'); await page.click('#reconnect');
        await page.waitForFunction(() => !(document.getElementById('generate') as HTMLButtonElement).disabled);
        assert.equal(loginRequests, 1);
        await page.screenshot({path:path.join(output,'auto-reconnected.png')});
        await page.selectOption('#form', 'mc202');
        await page.waitForFunction(() => !(document.getElementById('generate') as HTMLButtonElement).disabled);
        await page.reload();
        await page.waitForFunction(() => !(document.getElementById('generate') as HTMLButtonElement).disabled);
        assert.equal(await page.locator('#form').inputValue(), 'mc202');
        assert.equal(loginRequests, 1);
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
        const savesBeforeZip=savedCopies.length;
        const zipRequest=page.waitForRequest(req=>req.url().endsWith('/excel/generate-package'));
        await page.click('#generatePackage');
        const zipPayload=(await zipRequest).postDataJSON();
        assert.equal(zipPayload.forms.length,3);
        assert.equal(zipPayload.forms.reduce((count:number,item:any)=>count+Object.keys(item.values).length,0),101);
        assert.equal(zipPayload.forms[0].values.dc105_24,'10/5/2026');
        await page.waitForSelector('#packageResult:visible');
        assert.equal(await page.locator('#packageFiles li').count(),3);
        assert.equal(savedCopies.length,savesBeforeZip,'ZIP never triggers optional cloud delivery');
        await page.screenshot({path:path.join(output,'three-form-zip-mobile.png'),fullPage:true});
        const zipEvent=page.waitForEvent('download');await page.click('#downloadPackage');
        const zipDownload=await zipEvent;
        assert.equal(zipDownload.suggestedFilename(),'FORMS - 29th - 26-00001-LT - Example Property LLC v Morgan Tenant.zip');
        const zipPath=path.join(output,zipDownload.suggestedFilename());await zipDownload.saveAs(zipPath);
        const zipReadback=spawnSync(process.env.EXCEL_PDF_PYTHON||'python3',['-c',
            'import sys,io,json,zipfile; from pypdf import PdfReader; z=zipfile.ZipFile(sys.argv[1]); assert z.testzip() is None; result=[]\nfor name in z.namelist():\n r=PdfReader(io.BytesIO(z.read(name))); f=r.get_fields(); assert any(str(v.get("/V"))=="Morgan Tenant" for v in f.values()); result.append({"name":name,"fields":len(f),"pages":len(r.pages)})\nprint(json.dumps(result))',zipPath],{windowsHide:true});
        assert.equal(zipReadback.status,0,zipReadback.stderr.toString());
        const zipped=JSON.parse(zipReadback.stdout.toString());
        assert.equal(zipped.length,3);assert.equal(zipped.reduce((count:number,item:any)=>count+item.fields,0),101);
        assert.equal(zipped.reduce((count:number,item:any)=>count+item.pages,0),4);
        // Even a field belonging to a form not selected in the dropdown invalidates the ZIP.
        await page.evaluate(()=>{const qa=(window as any).qa;qa.values[qa.headers.indexOf('dc508_03')]='Changed without events';});
        let zipUnexpectedDownload=false;
        const unexpectedZip=()=>{zipUnexpectedDownload=true;};page.on('download',unexpectedZip);
        await page.click('#downloadPackage');
        await page.waitForFunction(()=>document.getElementById('error')?.textContent?.includes('changed since this ZIP'));
        assert.equal(zipUnexpectedDownload,false);page.off('download',unexpectedZip);
        assert.equal(await page.locator('#packageResult').isVisible(),false);
        await page.waitForFunction(()=>!(document.getElementById('generatePackage') as HTMLButtonElement).disabled);
        await page.route('**/excel/generate-package',route=>route.fulfill({status:422,contentType:'application/json',body:JSON.stringify({error:'DC508: Review date',field:'dc508_13'})}));
        await page.click('#generatePackage');
        await page.waitForFunction(()=>document.getElementById('error')?.textContent?.includes('DC508: Review date'));
        assert.equal(await page.locator('#packageResult').isVisible(),false);
        assert.equal(await page.locator('#generatePackage').isEnabled(),true);
        await page.unroute('**/excel/generate-package');
        await page.evaluate(()=>{const qa=(window as any).qa;qa.values[qa.headers.indexOf('dc508_03')]='';});
        await page.route('**/excel/generate-package',async route=>{
            await page.evaluate(()=>{const qa=(window as any).qa;qa.values[qa.headers.indexOf('dc105_01')]='Changed during generation';});
            await route.fulfill({contentType:'application/zip',body:fs.readFileSync(zipPath)});
        });
        await page.click('#generatePackage');
        await page.waitForFunction(()=>document.getElementById('error')?.textContent?.includes('changed during generation'));
        assert.equal(await page.locator('#packageResult').isVisible(),false);
        await page.unroute('**/excel/generate-package');
        await page.waitForFunction(()=>!(document.getElementById('generatePackage') as HTMLButtonElement).disabled);
        await page.evaluate(()=>{const qa=(window as any).qa;qa.values[qa.headers.indexOf('dc105_01')]='';});
        await page.setViewportSize({width:1440,height:950});
        await page.click('#generatePackage');await page.waitForSelector('#packageResult:visible');
        await page.screenshot({path:path.join(output,'three-form-zip-desktop.png'),fullPage:true});
        assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
        // Restore individual preview before the existing single-form regression scenarios.
        await page.setViewportSize({width:380,height:850});
        await page.click('#generate');
        await page.waitForFunction(()=>document.getElementById('status')?.textContent?.includes('Fillable fields retained'));
        await page.click('#back');
        await page.fill('#filename', 'reviewed copy');
        await page.click('#refresh');
        await page.waitForFunction(() => !(document.getElementById('generate') as HTMLButtonElement).disabled);
        assert.equal(await page.locator('#filename').inputValue(), 'reviewed copy');
        const namedRequest = page.waitForRequest(req => req.url().endsWith('/excel/generate'));
        await page.click('#generate');
        assert.equal((await namedRequest).postDataJSON().filename, 'MC202 - reviewed copy.pdf');
        await page.waitForFunction(() => document.getElementById('status')?.textContent?.includes('Fillable fields retained'));
        const namedDownloadEvent = page.waitForEvent('download'); await page.click('#save');
        const namedDownload = await namedDownloadEvent;
        assert.equal(namedDownload.suggestedFilename(), 'MC202 - reviewed copy.pdf');
        await namedDownload.saveAs(path.join(output, namedDownload.suggestedFilename()));
        await page.fill('#filename', '../invalid.pdf');
        assert.equal(await page.locator('#result').isVisible(), false);
        let invalidNameRequests = 0;
        const countInvalid = (request: any) => { if (request.url().endsWith('/excel/generate')) invalidNameRequests++; };
        page.on('request', countInvalid); await page.click('#generate');
        await page.waitForFunction(() => document.getElementById('error')?.textContent?.includes('Windows cannot use'));
        page.off('request', countInvalid);
        assert.equal(invalidNameRequests, 0);
        assert.equal(await page.locator('#filename').getAttribute('aria-invalid'), 'true');
        await page.click('#resetFilename');
        assert.ok((await page.locator('#filename').inputValue()).includes('Example Property LLC v Morgan Tenant.pdf'));
        await page.click('#generate');
        await page.waitForFunction(() => document.getElementById('status')?.textContent?.includes('Fillable fields retained'));
        // Verify visible marks, not only stored checkbox values or nonempty appearances.
        await page.evaluate('import("/excel/pdfjs/pdf.mjs").then(module => { window.qaPdfjs = module; })');
        let checkedWidgets = 0;
        for (const form of EXCEL_FORMS) {
            const buttons = spawnSync(process.env.EXCEL_PDF_PYTHON || 'python3', ['-c',
                'import sys,json; from pypdf import PdfReader; print(json.dumps([n for n,f in PdfReader(sys.argv[1]).get_fields().items() if f.get("/FT")=="/Btn"]))',
                path.resolve('assets/excel-pdf', form.id + '.pdf')], { windowsHide:true });
            assert.equal(buttons.status,0,buttons.stderr.toString());
            const names = JSON.parse(buttons.stdout.toString()) as string[];
            const off = Object.fromEntries(form.fields.map(name=>[name,'']));
            const on = {...off,...Object.fromEntries(names.map(name=>[name,true]))};
            const offPdf = await generateExcelPdf(form.id,off);
            const onPdf = await generateExcelPdf(form.id,on);
            const comparison = await page.evaluate(async ({off,on})=>{
                const pdfjs = (window as any).qaPdfjs;
                const read = async(bytes:number[],capture=false)=>{
                    const task=pdfjs.getDocument({data:new Uint8Array(bytes),isEvalSupported:false,
                        standardFontDataUrl:'/excel/pdfjs/standard_fonts/',cMapUrl:'/excel/pdfjs/cmaps/',cMapPacked:true});
                    const pdf=await task.promise;
                    const patches:Record<string,number[]>={},images:string[]=[];
                    for(let number=1;number<=pdf.numPages;number++) {
                        const pdfPage=await pdf.getPage(number),viewport=pdfPage.getViewport({scale:3});
                        const canvas=document.createElement('canvas');canvas.width=Math.ceil(viewport.width);canvas.height=Math.ceil(viewport.height);
                        const context=canvas.getContext('2d')!;
                        await pdfPage.render({canvas,canvasContext:context,viewport}).promise;
                        if(capture) images.push(canvas.toDataURL('image/png').split(',')[1]);
                        for(const annotation of await pdfPage.getAnnotations()) if(annotation.checkBox) {
                            const rect=[...viewport.convertToViewportPoint(annotation.rect[0],annotation.rect[1]),
                                ...viewport.convertToViewportPoint(annotation.rect[2],annotation.rect[3])];
                            const x=Math.floor(Math.min(rect[0],rect[2]))+2,y=Math.floor(Math.min(rect[1],rect[3]))+2;
                            const width=Math.ceil(Math.abs(rect[2]-rect[0]))-4,height=Math.ceil(Math.abs(rect[3]-rect[1]))-4;
                            patches[annotation.fieldName]=Array.from(context.getImageData(x,y,width,height).data);
                        }
                    }
                    await task.destroy();return {patches,images};
                };
                const blank=(await read(off)).patches,marked=await read(on,true);
                return {fields:Object.keys(marked.patches).map(name=>({name,
                    changed:marked.patches[name].reduce((sum,value,i)=>sum+(Math.abs(value-blank[name][i])>25?1:0),0)})),images:marked.images};
            },{off:Array.from(offPdf),on:Array.from(onPdf)});
            assert.equal(comparison.fields.length,names.length);
            for(const checkbox of comparison.fields) assert.ok(checkbox.changed>8,'Checkbox must render visibly: '+checkbox.name);
            checkedWidgets+=comparison.fields.length;
            fs.writeFileSync(path.join(output,form.id+'-checkbox-render.json'),JSON.stringify(comparison.fields,null,2));
            comparison.images.forEach((image,index)=>fs.writeFileSync(path.join(output,form.id+'-checkboxes-page-'+(index+1)+'.png'),Buffer.from(image,'base64')));
        }
        assert.equal(checkedWidgets,31);
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
        await page.evaluate(()=>{
            const qa=(window as any).qa;qa.values[qa.headers.indexOf('Landlord')]='W'.repeat(200);qa.events[1]();
        });
        await page.waitForFunction(()=>!(document.getElementById('generate') as HTMLButtonElement).disabled);
        await page.click('#generate');
        await page.waitForFunction(()=>document.getElementById('error')?.textContent?.includes('Source: Working Document / CJ36.'));
        assert.ok((await page.locator('#error').innerText()).includes('too long to display legibly'));
        assert.equal(await page.locator('#result').isVisible(),false);
        assert.equal(savedCopies.length,3);
        await page.screenshot({path:path.join(output,'source-field-error.png'),fullPage:true});
        await page.evaluate(()=>{
            const qa=(window as any).qa;qa.values[qa.headers.indexOf('Landlord')]='Updated Example LLC';qa.events[1]();
        });
        await page.waitForFunction(()=>!(document.getElementById('generate') as HTMLButtonElement).disabled);
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
        assert.equal(await page.evaluate(() => localStorage.getItem('devlin.excel.session.v1') !== null), true);
        await page.click('#logout'); await page.waitForSelector('#signIn:visible');
        assert.equal(await page.evaluate(() => localStorage.getItem('devlin.excel.session.v1')), null);
        assert.equal(await page.evaluate(() => localStorage.getItem('devlin.excel.form.v1')), 'mc202');
        await page.reload(); await page.waitForSelector('#signIn:visible');
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
        await page.evaluate(token => localStorage.setItem('devlin.excel.session.v1', JSON.stringify({token,expiresAt:Date.now()-1})), remembered.token);
        await page.reload(); await page.waitForSelector('#signIn:visible');
        assert.equal(await page.evaluate(() => localStorage.getItem('devlin.excel.session.v1')), null);
        await page.addInitScript(() => Object.defineProperty(window, 'localStorage', {get(){throw new Error('Storage disabled for QA');}}));
        await page.reload(); await page.waitForSelector('#signIn:visible');
        await page.fill('#username','excel-qa'); await page.fill('#password','excel-qa-only'); await page.click('#login');
        await page.waitForFunction(() => !(document.getElementById('generate') as HTMLButtonElement).disabled);
        await page.click('#generate');
        await page.waitForFunction(() => document.getElementById('status')?.textContent?.includes('Fillable fields retained'));
        await page.clock.fastForward(12 * 60 * 60_000 + 1);
        await page.waitForSelector('#signIn:visible');
        assert.ok((await page.locator('#error').innerText()).includes('12-hour Excel connection expired'));
        assert.equal(await page.locator('#result').isVisible(), false);
        assert.deepEqual(errors, []);
        console.log('Excel task-pane smoke passed with an explicit simulated Excel 1.9 host: a local three-form ZIP (101 fillable fields, four pages), ZIP change guards and partial-failure recovery, 12-hour session restoration after reload and reopening, password-free outage recovery, logout and expired-session cleanup, disabled-storage fallback, individual fillable downloads, all 31 checkbox marks rendered and compared on/off, source-cell errors, formula PDF readback, simulated OneDrive delivery, responsive previews, calculation/change guards and network recovery. No real OneDrive uploads.');
    } finally {
        await browser.close();
        await new Promise<void>(resolve => { server.close(() => resolve()); server.closeIdleConnections(); });
    }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
