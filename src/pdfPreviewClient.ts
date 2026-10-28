export const PDF_PREVIEW_STYLE = `
.pdf-preview{font:13px/1.4 Arial,sans-serif;display:flex;flex:1;flex-direction:column;min-width:0;min-height:0;overflow:hidden;background:#e5e7eb;color:#222}
.pdf-preview-toolbar{display:flex;flex-wrap:wrap;align-items:center;justify-content:center;gap:6px;flex-shrink:0;padding:8px;background:#fff;border-bottom:1px solid #ccd0d6}
.pdf-preview-toolbar button,.pdf-preview-toolbar input,.pdf-preview-toolbar select,.pdf-preview-original{height:32px;min-height:32px;border:1px solid #ccd0d6;border-radius:4px;background:#fff;color:#222;font:inherit;letter-spacing:0}
.pdf-preview-toolbar button,.pdf-preview-original{width:32px;display:inline-flex;align-items:center;justify-content:center;padding:0;cursor:pointer;text-decoration:none}
.pdf-preview-toolbar button:disabled,.pdf-preview-toolbar input:disabled{opacity:.45;cursor:default}
.pdf-preview-toolbar svg{width:16px;height:16px;flex-shrink:0}
.pdf-preview-toolbar input{width:48px;padding:2px;text-align:center}
.pdf-preview-toolbar select{width:auto;max-width:110px;padding:2px 4px}
.pdf-preview-total{min-width:26px}
.pdf-preview-pages{flex:1;min-height:0;min-width:0;overflow:auto;padding:12px}
.pdf-preview-pages canvas{display:block;margin:auto;background:#fff;box-shadow:0 1px 3px #0002;max-width:none}
.pdf-preview-message{padding:20px;overflow-wrap:anywhere;text-align:center}
.pdf-preview-retry{display:block;align-self:center;min-height:36px;margin:0 12px 12px;padding:6px 12px;border:1px solid #ccd0d6;border-radius:4px;background:#fff;color:#222;font:inherit;cursor:pointer}
.pdf-preview [hidden]{display:none!important}
`;

// Serialized after compilation; the supplied loader keeps native browser import().
function installPdfPreview(loadPdfJs: () => Promise<any>): void {
    function create(container: HTMLElement, options: { source: string; label?: string }) {
        const source = new URL(options.source, window.location.href);
        if (source.origin !== window.location.origin || !['http:', 'https:'].includes(source.protocol)) {
            throw new Error('PDF preview requires a same-origin document.');
        }
        const root = document.createElement('section');
        root.className = 'pdf-preview';
        root.setAttribute('aria-label', options.label || 'PDF preview');
        root.innerHTML = '<div class="pdf-preview-toolbar" aria-label="PDF controls">' +
            '<button type="button" data-pdf-action="previous" aria-label="Previous page" title="Previous page" disabled><i data-lucide="chevron-left"></i></button>' +
            '<input type="number" data-pdf-action="page" min="1" value="1" aria-label="Page number" disabled><span class="pdf-preview-total">/ 0</span>' +
            '<button type="button" data-pdf-action="next" aria-label="Next page" title="Next page" disabled><i data-lucide="chevron-right"></i></button>' +
            '<select data-pdf-action="zoom" aria-label="PDF zoom"><option value="fit">Fit width</option><option value="0.75">75%</option><option value="1">100%</option><option value="1.25">125%</option><option value="1.5">150%</option><option value="2">200%</option></select>' +
            '<a class="pdf-preview-original" data-pdf-action="original" target="_blank" rel="noopener noreferrer" aria-label="Open original PDF" title="Open original PDF"><i data-lucide="external-link"></i></a></div>' +
            '<div class="pdf-preview-message" role="status">Loading PDF...</div>' +
            '<button type="button" class="pdf-preview-retry" hidden>Retry preview</button><div class="pdf-preview-pages"></div>';
        const previous = root.querySelector<HTMLButtonElement>('[data-pdf-action="previous"]')!;
        const next = root.querySelector<HTMLButtonElement>('[data-pdf-action="next"]')!;
        const pageInput = root.querySelector<HTMLInputElement>('[data-pdf-action="page"]')!;
        const zoom = root.querySelector<HTMLSelectElement>('[data-pdf-action="zoom"]')!;
        const original = root.querySelector<HTMLAnchorElement>('[data-pdf-action="original"]')!;
        const total = root.querySelector<HTMLElement>('.pdf-preview-total')!;
        const message = root.querySelector<HTMLElement>('.pdf-preview-message')!;
        const retryButton = root.querySelector<HTMLButtonElement>('.pdf-preview-retry')!;
        const pages = root.querySelector<HTMLElement>('.pdf-preview-pages')!;
        original.href = source.href;
        container.replaceChildren(root);
        (window as any).lucide?.createIcons();
        let pdf: any, loadingTask: any, renderTask: any;
        let current = 1, revision = 0, attempt = 0, destroyed = false, timedOut = false;
        let timer: ReturnType<typeof setTimeout> | undefined, resizeTimer: ReturnType<typeof setTimeout> | undefined;
        let renderedWidth = 0;

        function clearWork() {
            ++revision;
            renderTask?.cancel(); renderTask = undefined;
            const task = loadingTask;
            loadingTask = undefined; pdf = undefined;
            if (task) Promise.resolve(task.destroy()).catch(() => {});
        }
        function fail(text: string) {
            root.dataset.pdfState = 'error';
            message.textContent = text; message.hidden = false; retryButton.hidden = false;
            previous.disabled = next.disabled = pageInput.disabled = true;
            pages.replaceChildren();
        }
        function describe(error: any) {
            if (error?.status === 401) return 'Your connection expired. Sign in again.';
            if (error?.status === 404) return 'This PDF is no longer available.';
            if (error?.status >= 500) return 'The PDF service is temporarily unavailable.';
            if (error?.name === 'PasswordException') return 'This PDF is password protected.';
            if (error?.name === 'InvalidPDFException') return 'The document is not a readable PDF.';
            return 'Unable to load the PDF.';
        }
        async function render() {
            if (!pdf || destroyed || timedOut || pages.clientWidth === 0) return;
            const document = pdf, token = ++revision;
            renderTask?.cancel(); renderTask = undefined;
            try {
                const page = await document.getPage(current);
                if (destroyed || token !== revision || pdf !== document) return;
                const base = page.getViewport({scale:1});
                const scale = zoom.value === 'fit' ? Math.max(.2, (pages.clientWidth - 24) / base.width) : Number(zoom.value);
                const viewport = page.getViewport({scale});
                const ratio = Math.min(window.devicePixelRatio || 1, 2, Math.sqrt(16_000_000 / (viewport.width * viewport.height)));
                const canvas = window.document.createElement('canvas');
                canvas.width = Math.ceil(viewport.width * ratio); canvas.height = Math.ceil(viewport.height * ratio);
                canvas.style.width = viewport.width + 'px'; canvas.style.height = viewport.height + 'px';
                canvas.setAttribute('aria-label', 'PDF page ' + current);
                const task = page.render({canvasContext:canvas.getContext('2d'), viewport, transform:ratio === 1 ? null : [ratio,0,0,ratio,0,0]});
                renderTask = task;
                await task.promise;
                if (destroyed || token !== revision || pdf !== document) return;
                pages.replaceChildren(canvas); message.hidden = true; retryButton.hidden = true;
                root.dataset.pdfState = 'ready'; renderedWidth = pages.clientWidth;
                pageInput.value = String(current); pageInput.max = String(document.numPages); pageInput.disabled = false;
                total.textContent = '/ ' + document.numPages;
                previous.disabled = current <= 1; next.disabled = current >= document.numPages;
            } catch (error: any) {
                if (!destroyed && token === revision && error?.name !== 'RenderingCancelledException') fail('Unable to display the PDF.');
            }
        }
        async function load() {
            if (destroyed) return;
            const owner = ++attempt;
            clearTimeout(timer); clearWork(); timedOut = false; current = 1;
            pages.replaceChildren(); total.textContent = '/ 0'; pageInput.value = '1';
            previous.disabled = next.disabled = pageInput.disabled = true;
            root.dataset.pdfState = 'loading'; message.hidden = false; message.textContent = 'Loading PDF...'; retryButton.hidden = true;
            timer = setTimeout(() => {
                if (destroyed || owner !== attempt) return;
                timedOut = true; clearWork(); fail('PDF preview timed out.');
            }, 45_000);
            try {
                const pdfjs = await loadPdfJs();
                if (destroyed || owner !== attempt || timedOut) return;
                pdfjs.GlobalWorkerOptions.workerSrc = '/assets/pdfjs/pdf.worker.mjs';
                const task = pdfjs.getDocument({url:source.href,withCredentials:true,isEvalSupported:false,useSystemFonts:true,
                    wasmUrl:'/assets/pdfjs/wasm/',standardFontDataUrl:'/assets/pdfjs/standard_fonts/',cMapUrl:'/assets/pdfjs/cmaps/',cMapPacked:true});
                loadingTask = task;
                const loaded = await task.promise;
                if (destroyed || owner !== attempt || timedOut) return;
                pdf = loaded;
                await render();
            } catch (error) {
                if (!destroyed && owner === attempt && !timedOut) { clearWork(); fail(describe(error)); }
            } finally { if (owner === attempt) clearTimeout(timer); }
        }
        previous.onclick = () => { current = Math.max(1, current - 1); void render(); };
        next.onclick = () => { if (pdf) { current = Math.min(pdf.numPages, current + 1); void render(); } };
        pageInput.onchange = () => { if (pdf) { current = Math.max(1, Math.min(pdf.numPages, Math.floor(Number(pageInput.value)) || 1)); void render(); } };
        zoom.onchange = () => { void render(); };
        retryButton.onclick = () => { void load(); };
        const resize = () => {
            clearTimeout(resizeTimer);
            resizeTimer = setTimeout(() => { if (Math.abs(pages.clientWidth - renderedWidth) > 2) void render(); }, 100);
        };
        const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(resize) : undefined;
        observer?.observe(pages);
        window.addEventListener('resize', resize);
        void load();
        return {
            retry: load,
            destroy() {
                if (destroyed) return;
                destroyed = true; ++attempt; clearTimeout(timer); clearTimeout(resizeTimer); clearWork();
                observer?.disconnect(); window.removeEventListener('resize', resize); root.remove();
            },
        };
    }
    (window as any).DevlinPdfPreview = {create};
}

export const PDF_PREVIEW_SCRIPT = '(' + installPdfPreview.toString() + ')(()=>import("/assets/pdfjs/pdf.mjs"));';
