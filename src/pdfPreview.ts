export function pdfPreviewHtml(documentId: string, version = ''): string {
    const source = `/api/documents/${encodeURIComponent(documentId)}/content?v=${encodeURIComponent(version)}`;
    return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>PDF preview</title><style>
*{box-sizing:border-box}body{margin:0;font:13px Arial,sans-serif;background:#e5e7eb;color:#222}
header{position:sticky;top:0;z-index:1;display:flex;align-items:center;justify-content:center;gap:6px;padding:8px;background:#fff;border-bottom:1px solid #ccd0d6;flex-wrap:wrap}
button,input,select{height:30px;border:1px solid #ccd0d6;border-radius:4px;background:#fff;color:#222}
button{width:30px;display:inline-flex;align-items:center;justify-content:center;cursor:pointer}button:disabled{opacity:.4;cursor:default}
button svg{width:16px;height:16px}input{width:48px;text-align:center}select{max-width:110px}#total{min-width:26px}
main{padding:12px;display:flex;justify-content:center;overflow:auto}canvas{display:block;background:#fff;box-shadow:0 1px 3px #0002;max-width:none}
#message{padding:20px;overflow-wrap:anywhere}a{color:#165e7a;text-decoration:none;margin-left:5px}
</style></head><body>
<header aria-label="PDF controls">
<button id="previous" type="button" title="Previous page" aria-label="Previous page" disabled><i data-lucide="chevron-left"></i></button>
<input id="page" type="number" min="1" value="1" aria-label="Page number" disabled><span id="total">/ 0</span>
<button id="next" type="button" title="Next page" aria-label="Next page" disabled><i data-lucide="chevron-right"></i></button>
<select id="zoom" aria-label="PDF zoom"><option value="fit">Fit width</option><option value="0.75">75%</option><option value="1">100%</option><option value="1.25">125%</option><option value="1.5">150%</option><option value="2">200%</option></select>
<a href="${source}" target="_blank" rel="noopener" title="Open original PDF">PDF</a>
</header><div id="message" role="status">Loading PDF...</div><main id="pages"></main>
<script src="/assets/lucide.js"></script>
<script type="module">
import * as pdfjs from '/assets/pdfjs/pdf.mjs';
pdfjs.GlobalWorkerOptions.workerSrc = '/assets/pdfjs/pdf.worker.mjs';
lucide.createIcons();
let pdf, current = 1, generation = 0;
const pages = document.getElementById('pages'), message = document.getElementById('message');
const input = document.getElementById('page'), previous = document.getElementById('previous'), next = document.getElementById('next'), zoom = document.getElementById('zoom');
async function render() {
  if (!pdf) return;
  const token = ++generation;
  try {
    const page = await pdf.getPage(current);
    const base = page.getViewport({scale:1});
    const scale = zoom.value === 'fit' ? Math.max(.2, (document.documentElement.clientWidth - 24) / base.width) : Number(zoom.value);
    const ratio = Math.min(window.devicePixelRatio || 1, 2);
    const viewport = page.getViewport({scale});
    const canvas = document.createElement('canvas');
    canvas.width = Math.ceil(viewport.width * ratio); canvas.height = Math.ceil(viewport.height * ratio);
    canvas.style.width = viewport.width + 'px'; canvas.style.height = viewport.height + 'px';
    canvas.setAttribute('aria-label', 'PDF page ' + current);
    await page.render({canvasContext:canvas.getContext('2d'), viewport, transform:ratio === 1 ? null : [ratio,0,0,ratio,0,0]}).promise;
    if (token !== generation) return;
    pages.replaceChildren(canvas); message.hidden = true;
    input.value = current; input.max = pdf.numPages; input.disabled = false;
    previous.disabled = current <= 1; next.disabled = current >= pdf.numPages;
    document.getElementById('total').textContent = '/ ' + pdf.numPages;
  } catch (error) { if (token === generation) { message.hidden = false; message.textContent = 'Unable to display PDF: ' + error.message; } }
}
previous.onclick = () => { current = Math.max(1,current-1); render(); };
next.onclick = () => { current = Math.min(pdf.numPages,current+1); render(); };
input.onchange = () => { current = Math.max(1,Math.min(pdf.numPages,Math.floor(Number(input.value)) || 1)); render(); };
zoom.onchange = render;
let timer;
window.addEventListener('resize', () => { clearTimeout(timer); timer = setTimeout(render, 100); });
try { pdf = await pdfjs.getDocument({url:${JSON.stringify(source)},isEvalSupported:false,useSystemFonts:true}).promise; await render(); }
catch (error) { message.textContent = 'Unable to load PDF: ' + error.message; }
</script></body></html>`;
}
