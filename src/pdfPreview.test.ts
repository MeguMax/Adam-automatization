import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { once } from 'node:events';
import { chromium, Page } from 'playwright';
import { PDF_PREVIEW_SCRIPT, PDF_PREVIEW_STYLE } from './pdfPreviewClient';
import { pdfPreviewHtml } from './pdfPreview';
import { testPdfFixture } from './testPdfFixture';

async function fixture(run: (page: Page, base: string, state: { status: number; delay: number; stall: boolean; requests: number }) => Promise<void>) {
    const state = {status:200,delay:0,stall:false,requests:0};
    const timers = new Set<ReturnType<typeof setTimeout>>();
    const server = http.createServer((req,res) => {
        const url = new URL(req.url!, 'http://localhost');
        const send = (type: string, body: string | Buffer) => { res.writeHead(200,{'Content-Type':type}); res.end(body); };
        if (url.pathname === '/') return send('text/html', `<!doctype html><html><head><style>
body{margin:0}#host{height:600px;width:900px;max-width:100%;display:flex}${PDF_PREVIEW_STYLE}</style></head><body>
<button id="switch">Second document</button><button id="show">Show preview</button><div id="host"></div>
<script src="/assets/lucide.js"></script><script src="/assets/pdf-preview.js"></script><script>
let controller;function showDocument(id){controller?.destroy();controller=DevlinPdfPreview.create(document.getElementById('host'),{source:'/api/documents/'+id+'/content'});}
document.getElementById('switch').onclick=()=>showDocument('second');
document.getElementById('show').onclick=()=>document.getElementById('host').style.display='flex';
if(location.hash==='#hidden')document.getElementById('host').style.display='none';showDocument('first');
</script></body></html>`);
        if (url.pathname === '/standalone') return send('text/html',pdfPreviewHtml('first'));
        if (url.pathname === '/assets/pdf-preview.js') return send('text/javascript',PDF_PREVIEW_SCRIPT);
        if (url.pathname === '/assets/lucide.js') return send('text/javascript',fs.readFileSync(require.resolve('lucide/dist/umd/lucide.min.js')));
        const asset = url.pathname.match(/^\/assets\/pdfjs\/(?:((?:standard_fonts|cmaps|wasm))\/)?([\w.-]+)$/);
        if (asset) {
            const folder = asset[1] || 'build';
            const file = path.join(path.dirname(require.resolve('pdfjs-dist/package.json')),folder,asset[2]);
            if (fs.existsSync(file)) return send(file.endsWith('.mjs') ? 'text/javascript' : file.endsWith('.wasm') ? 'application/wasm' : 'application/octet-stream',fs.readFileSync(file));
        }
        if (/^\/api\/documents\/(first|second)\/content$/.test(url.pathname)) {
            state.requests++;
            if (state.stall) return;
            const finish = () => {
                if (res.destroyed) return;
                if (state.status !== 200) { res.writeHead(state.status,{'Content-Type':'text/html'}); res.end('Temporary test error'); return; }
                const data = url.pathname.includes('/second/') ? testPdfFixture('SECOND DOCUMENT QA') : fs.readFileSync(path.resolve('assets/excel-pdf/dc508.pdf'));
                send('application/pdf',data);
            };
            if (state.delay && url.pathname.includes('/first/')) {
                const timer = setTimeout(() => {timers.delete(timer);finish();},state.delay);timers.add(timer);
            } else finish();
            return;
        }
        res.writeHead(404);res.end();
    });
    server.listen(0,'127.0.0.1');await once(server,'listening');
    const base='http://127.0.0.1:'+(server.address() as {port:number}).port;
    const browser=await chromium.launch({headless:true});
    try {
        const page=await browser.newPage({viewport:{width:1024,height:800}});
        await run(page,base,state);
    } finally {
        await browser.close();for(const timer of timers)clearTimeout(timer);
        await new Promise<void>(resolve=>{server.close(()=>resolve());server.closeAllConnections();});
    }
}

const ready = (page: Page) => page.locator('[data-pdf-state="ready"]').waitFor({state:'visible'});
const nonblank = (page: Page) => page.locator('canvas').evaluate((canvas: HTMLCanvasElement) => {
    const pixels=canvas.getContext('2d')!.getImageData(0,0,canvas.width,canvas.height).data;
    let ink=0;for(let i=0;i<pixels.length;i+=4)if(pixels[i+3]>0&&pixels[i]<180)ink++;
    return ink>100;
});

test('inline PDF controls render both pages, retain zoom, fit mobile and share the standalone renderer', async()=>fixture(async(page,base)=>{
    await page.goto(base);await ready(page);
    assert.equal(await page.locator('iframe').count(),0);assert.equal(await nonblank(page),true);
    assert.equal(await page.getByRole('button',{name:'Previous page',exact:true}).isDisabled(),true);
    await page.getByRole('button',{name:'Next page',exact:true}).click();
    await page.waitForFunction(()=>document.querySelector('canvas')?.getAttribute('aria-label')==='PDF page 2');
    assert.equal(await page.getByRole('button',{name:'Next page',exact:true}).isDisabled(),true);
    await page.getByRole('combobox',{name:'PDF zoom'}).selectOption('1.5');
    await page.waitForFunction(()=>parseFloat(document.querySelector('canvas')!.style.width)>900);
    await page.getByRole('spinbutton',{name:'Page number'}).fill('1');
    await page.getByRole('spinbutton',{name:'Page number'}).press('Tab');
    await page.waitForFunction(()=>document.querySelector('canvas')?.getAttribute('aria-label')==='PDF page 1');
    assert.equal(await page.getByRole('combobox',{name:'PDF zoom'}).inputValue(),'1.5');
    await page.getByRole('combobox',{name:'PDF zoom'}).selectOption('fit');
    await page.waitForFunction(()=>parseFloat(document.querySelector('canvas')!.style.width)<=880);
    const output=path.resolve('output/preview-qa');fs.mkdirSync(output,{recursive:true});
    await page.screenshot({path:path.join(output,'inline-desktop.png')});
    await page.setViewportSize({width:375,height:720});
    await page.waitForFunction(()=>document.querySelector('canvas')!.getBoundingClientRect().width<=document.querySelector('.pdf-preview-pages')!.clientWidth-23);
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
    await page.screenshot({path:path.join(output,'inline-mobile.png')});
    await page.goto(base+'/standalone');await ready(page);assert.equal(await nonblank(page),true);
}));

test('a slow PDF loads once without iframe blank-reload timers cancelling the request', async()=>fixture(async(page,base,state)=>{
    state.delay=6500;await page.goto(base);await ready(page);
    assert.equal(state.requests,1);assert.equal(await nonblank(page),true);
}));

test('temporary PDF errors expose retry and original links and recover without reopening a Draft', async()=>fixture(async(page,base,state)=>{
    state.status=502;await page.goto(base);
    await page.getByRole('button',{name:'Retry preview',exact:true}).waitFor({state:'visible'});
    assert.match(await page.locator('.pdf-preview-message').innerText(),/temporarily unavailable/);
    const link=page.getByRole('link',{name:'Open original PDF'});
    assert.equal(await link.getAttribute('href'),base+'/api/documents/first/content');
    assert.equal(await link.getAttribute('target'),'_blank');
    state.status=200;await page.getByRole('button',{name:'Retry preview',exact:true}).click();
    await ready(page);assert.equal(await nonblank(page),true);assert.equal(state.requests,2);
}));

test('changing documents cancels old work and late responses cannot replace the new PDF', async()=>fixture(async(page,base,state)=>{
    state.delay=1000;
    const requested=page.waitForRequest(request=>request.url().includes('/first/content'));
    await page.goto(base);await requested;
    await page.getByRole('button',{name:'Second document',exact:true}).click();await ready(page);
    const canvas=page.locator('canvas');await canvas.evaluate(c=>c.setAttribute('data-current-document','second'));
    await new Promise(resolve=>setTimeout(resolve,1200));
    assert.equal(await canvas.getAttribute('data-current-document'),'second');
    assert.ok((await page.getByRole('link',{name:'Open original PDF'}).getAttribute('href'))?.includes('/second/content'));
    assert.equal(await nonblank(page),true);
}));

test('a stalled request times out, aborts and remains manually retryable', async()=>fixture(async(page,base,state)=>{
    state.stall=true;await page.clock.install();
    const requested=page.waitForRequest(request=>request.url().includes('/first/content'));
    await page.goto(base);await requested;await page.clock.fastForward(45_001);await page.clock.resume();
    await page.getByRole('button',{name:'Retry preview',exact:true}).waitFor({state:'visible'});
    assert.match(await page.locator('.pdf-preview-message').innerText(),/timed out/);
    state.stall=false;await page.getByRole('button',{name:'Retry preview',exact:true}).click();
    await ready(page);assert.equal(await nonblank(page),true);
}));

test('initially hidden mobile panels render when shown without another download', async()=>fixture(async(page,base,state)=>{
    const loaded=page.waitForResponse(response=>response.url().includes('/first/content'));
    await page.goto(base+'/#hidden');
    await loaded;
    await page.getByRole('button',{name:'Show preview',exact:true}).click();await ready(page);
    assert.equal(await nonblank(page),true);assert.equal(state.requests,1);
    assert.equal(await page.evaluate(()=>{
        try {(window as any).DevlinPdfPreview.create(document.createElement('div'),{source:'https://untrusted.example/document.pdf'});return false;}
        catch{return true;}
    }),true);
}));
