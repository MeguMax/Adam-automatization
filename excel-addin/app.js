(function() {
    'use strict';
    const $ = id => document.getElementById(id);
    let token = '', forms = [], officeReady = false, busy = false, pdfUrl = '', revision = 0, pdfTask = null, previewBlob = null, previewWidth = 0;
    let selectedData = null, resultSnapshot = null, refreshTimer;
    function message(error, status = '') { $('error').textContent = error; $('status').textContent = status; }
    function controls() {
        $('generate').disabled = busy || !officeReady || !token || !forms.length || !selectedData;
        $('refresh').disabled = busy || !officeReady; $('form').disabled = busy || !forms.length;
        for (const id of ['download','save']) $(id).setAttribute('aria-disabled',String(busy || !pdfUrl));
    }
    function clearResult() {
        if (pdfUrl) URL.revokeObjectURL(pdfUrl);
        pdfUrl = ''; previewBlob = null; resultSnapshot = null;
        if (pdfTask) pdfTask.destroy().catch(() => {});
        pdfTask = null; $('preview').replaceChildren(); $('result').hidden = true;
        for (const id of ['download','save']) { $(id).removeAttribute('href'); $(id).removeAttribute('download'); }
    }
    function signedOut() { ++revision; token = ''; selectedData = null; clearResult(); $('workspace').hidden = true; $('signIn').hidden = false; $('logout').hidden = true; controls(); }
    async function api(url, data) {
        const response = await fetch(url, { method:'POST', credentials:'omit', headers:{'Content-Type':'application/json', ...(token ? { Authorization:'Bearer ' + token } : {})}, body:JSON.stringify(data) });
        if (!response.ok) {
            const result = await response.json();
            if (response.status === 401 && token) signedOut();
            throw new Error(result.error || 'Request failed.');
        }
        return response;
    }
    async function readSelection(options = {}) {
        if (!officeReady) throw new Error('Excel connection unavailable.');
        const form = forms.find(item => item.id === $('form').value);
        if (!form) throw new Error('Select a court form.');
        return DevlinExcelWorkbook.readSelection(Excel,form,options);
    }
    function showSelection(data) {
        selectedData = data;
        $('selection').textContent = data.sheet + ' / Row ' + data.row;
        $('caseName').textContent = data.name;
        $('caseContext').textContent = [data.metadata.plaintiff,data.metadata.court,data.metadata.caseNumber].filter(Boolean).join(' / ');
    }
    async function renderPreview(blob) {
        const expectedRevision = revision;
        if (pdfTask) await pdfTask.destroy();
        $('preview').replaceChildren();
        previewWidth = $('preview').clientWidth;
        const pdfjs = await import('/excel/pdfjs/pdf.mjs');
        if (expectedRevision !== revision || !token) return;
        pdfjs.GlobalWorkerOptions.workerSrc = '/excel/pdfjs/pdf.worker.mjs';
        const task = pdfjs.getDocument({ data:new Uint8Array(await blob.arrayBuffer()), isEvalSupported:false,
            standardFontDataUrl:'/excel/pdfjs/standard_fonts/', cMapUrl:'/excel/pdfjs/cmaps/', cMapPacked:true, wasmUrl:'/excel/pdfjs/wasm/' });
        pdfTask = task;
        const pdf = await task.promise;
        for (let number = 1; number <= pdf.numPages; number++) {
            if (pdfTask !== task || expectedRevision !== revision || !token) return;
            const page = await pdf.getPage(number);
            const original = page.getViewport({ scale:1 });
            const width = $('preview').clientWidth - 14;
            const viewport = page.getViewport({ scale:(width / original.width) * Math.min(devicePixelRatio || 1, 2) });
            const canvas = document.createElement('canvas'); canvas.width = Math.ceil(viewport.width); canvas.height = Math.ceil(viewport.height);
            canvas.setAttribute('aria-label', 'PDF page ' + number + ' of ' + pdf.numPages);
            $('preview').append(canvas);
            await page.render({ canvasContext:canvas.getContext('2d'), canvas, viewport }).promise;
        }
    }
    async function refresh(keepMessage = false) {
        const current = ++revision;
        selectedData = null; clearResult(); controls();
        if (keepMessage !== true) message('');
        try { const data = await readSelection(); if (current === revision) showSelection(data); }
        catch(error) { if (current === revision) { $('selection').textContent = 'No case selected'; $('caseName').textContent = ''; $('caseContext').textContent = ''; message(error.message); } }
        finally { controls(); }
    }
    $('loginForm').addEventListener('submit', async event => {
        event.preventDefault(); $('login').disabled = true; message('');
        try {
            const response = await api('/excel/session', { username:$('username').value, password:$('password').value });
            token = (await response.json()).token;
            $('password').value = ''; $('signIn').hidden = true; $('workspace').hidden = false; $('logout').hidden = false;
            controls(); await refresh();
        } catch(error) { message(error.message); }
        finally { $('login').disabled = false; }
    });
    $('logout').addEventListener('click', async () => { try { await api('/excel/logout', {}); } finally { signedOut(); message(''); } });
    $('refresh').addEventListener('click', refresh);
    $('form').addEventListener('change', refresh);
    $('generate').addEventListener('click', async () => {
        if (busy) return;
        const generationRevision = ++revision;
        busy = true; controls(); clearResult(); message('', 'Reading selected row...');
        try {
            // Read again here, never reuse a preview snapshot after a worksheet edit.
            const data = await readSelection(); showSelection(data);
            message('', 'Generating PDF...');
            const response = await api('/excel/generate', { form:data.form, values:data.values });
            const blob = await response.blob();
            if (!token) return;
            if (generationRevision !== revision) { message('The worksheet changed during generation. Generate the PDF again.'); return; }
            const currentData = await readSelection({recalculate:false});
            if (generationRevision !== revision || !DevlinExcelWorkbook.sameSnapshot(data,currentData)) {
                selectedData = null; message('The worksheet changed during generation. Generate the PDF again.'); return;
            }
            pdfUrl = URL.createObjectURL(blob);
            previewBlob = blob;
            resultSnapshot = data;
            const filename = DevlinExcelRow.pdfFilename(data);
            for (const id of ['download', 'save']) { $(id).href = pdfUrl; $(id).download = filename; }
            $('resultName').textContent = data.name + ' / ' + filename; $('result').hidden = false;
            await renderPreview(blob);
            if (generationRevision !== revision) { clearResult(); message('The worksheet changed during generation. Generate the PDF again.'); return; }
            message('', 'PDF generated. Fillable fields retained.');
        } catch(error) { if (pdfUrl) message('PDF generated, but preview is unavailable. You can still download it.'); else message(error.message); }
        finally { busy = false; controls(); if (!selectedData && token) refresh(true); }
    });
    async function download(event) {
        event.preventDefault();
        if (busy || !pdfUrl || !resultSnapshot) return;
        const source = resultSnapshot, url = pdfUrl, current = revision;
        busy = true; controls(); message('', 'Checking current row...');
        try {
            const latest = await readSelection({recalculate:false});
            if (!token || current !== revision || url !== pdfUrl || !DevlinExcelWorkbook.sameSnapshot(source,latest)) {
                clearResult(); selectedData = null;
                throw new Error('The worksheet changed since this PDF was generated. Generate the PDF again.');
            }
            const link = document.createElement('a'); link.href = url; link.download = DevlinExcelRow.pdfFilename(source);
            document.body.append(link); link.click(); link.remove();
            message('', 'PDF download requested. Fillable fields retained.');
        } catch(error) { clearResult(); message(error.message); }
        finally { busy = false; controls(); if (!selectedData && token) refresh(true); }
    }
    $('download').addEventListener('click',download);
    $('save').addEventListener('click',download);
    fetch('/excel/catalog').then(response => { if (!response.ok) throw new Error('Forms are unavailable.'); return response.json(); }).then(data => {
        forms = data; $('form').replaceChildren(...forms.map(form => { const option = document.createElement('option'); option.value = form.id; option.textContent = form.title; return option; })); controls(); if (token) refresh();
    }).catch(error => message(error.message));
    if (window.lucide) lucide.createIcons();
    if (window.Office) Office.onReady(info => {
        officeReady = info.host === Office.HostType.Excel && Office.context.requirements.isSetSupported('ExcelApi', DevlinExcelWorkbook.MIN_EXCEL_API);
        controls();
        if (!officeReady) message('This panel requires Excel with Excel API '+DevlinExcelWorkbook.MIN_EXCEL_API+' or newer.');
        if (token) refresh();
        if (officeReady) Excel.run(async context => {
            const sheets = context.workbook.worksheets;
            const changed = () => {
                ++revision; selectedData = null; clearResult(); controls(); clearTimeout(refreshTimer);
                if (!busy && token) refreshTimer = setTimeout(() => refresh(),150);
            };
            sheets.onSelectionChanged.add(changed);
            sheets.onChanged.add(changed);
            sheets.onActivated.add(changed);
            sheets.onAdded.add(changed);
            sheets.onDeleted.add(changed);
            await context.sync();
        }).catch(() => { /* Before/after generation and download rechecks also protect hosts without change events. */ });
    });
    window.addEventListener('beforeunload', () => { if (pdfUrl) URL.revokeObjectURL(pdfUrl); });
    let resizeTimer;
    window.addEventListener('resize', () => {
        clearTimeout(resizeTimer);
        resizeTimer = setTimeout(() => {
            if (previewBlob && !busy && Math.abs($('preview').clientWidth - previewWidth) > 2) {
                renderPreview(previewBlob).catch(() => message('PDF preview is unavailable. You can still download it.'));
            }
        }, 180);
    });
})();
