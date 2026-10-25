(function() {
    'use strict';
    const $ = id => document.getElementById(id);
    let token = '', forms = [], officeReady = false, busy = false, pdfUrl = '', revision = 0, pdfTask = null, previewBlob = null, previewWidth = 0;
    function message(error, status = '') { $('error').textContent = error; $('status').textContent = status; }
    function controls() { $('generate').disabled = busy || !officeReady || !token || !forms.length; $('refresh').disabled = busy || !officeReady; $('form').disabled = busy || !forms.length; }
    function clearResult() { if (pdfUrl) URL.revokeObjectURL(pdfUrl); pdfUrl = ''; previewBlob = null; if (pdfTask) pdfTask.destroy().catch(() => {}); pdfTask = null; $('preview').replaceChildren(); $('result').hidden = true; }
    function signedOut() { ++revision; token = ''; clearResult(); $('workspace').hidden = true; $('signIn').hidden = false; $('logout').hidden = true; controls(); }
    async function api(url, data) {
        const response = await fetch(url, { method:'POST', credentials:'omit', headers:{'Content-Type':'application/json', ...(token ? { Authorization:'Bearer ' + token } : {})}, body:JSON.stringify(data) });
        if (!response.ok) {
            const result = await response.json();
            if (response.status === 401 && token) signedOut();
            throw new Error(result.error || 'Request failed.');
        }
        return response;
    }
    async function readSelection() {
        if (!officeReady) throw new Error('Excel connection unavailable.');
        const form = forms.find(item => item.id === $('form').value);
        if (!form) throw new Error('Select a court form.');
        return Excel.run(async context => {
            const selection = context.workbook.getSelectedRange();
            selection.load('rowIndex,rowCount');
            const sheet = selection.worksheet;
            sheet.load('name');
            const used = sheet.getUsedRange();
            used.load('columnIndex,columnCount');
            context.application.calculate(Excel.CalculationType.recalculate);
            await context.sync();
            DevlinExcelRow.assertSelection(selection);
            const width = used.columnIndex + used.columnCount;
            if (width > 2048) throw new Error('The worksheet has more than 2,048 used columns.');
            const headers = sheet.getRangeByIndexes(0, 0, 1, width);
            const row = sheet.getRangeByIndexes(selection.rowIndex, 0, 1, width);
            headers.load('values'); row.load('values,valueTypes'); context.application.load('calculationState');
            await context.sync();
            if (context.application.calculationState !== Excel.CalculationState.done) throw new Error('Excel is still calculating. Retry when calculation finishes.');
            const data = DevlinExcelRow.selectedFields(headers.values[0], row.values[0], row.valueTypes[0], form);
            const dates = [];
            for (const field of form.dateFields) if (typeof data.values[field] === 'number') {
                if (!Number.isInteger(data.values[field])) throw new Error('Time-bearing date in ' + field + ' requires review.');
                const formatted = context.workbook.functions.text(row.getCell(0, data.columns[field]), 'm/d/yyyy');
                formatted.load('value'); dates.push({ field, formatted });
            }
            if (dates.length) await context.sync();
            for (const date of dates) {
                if (!/^\d{1,2}\/\d{1,2}\/\d{4}$/.test(date.formatted.value)) throw new Error('Excel could not format ' + date.field + ' as a date.');
                data.values[date.field] = date.formatted.value;
            }
            const defendant = headers.values[0].indexOf('Defendant');
            const name = defendant >= 0 ? String(row.values[0][defendant] || '') : '';
            if (!name.trim()) throw new Error('The selected row has no Defendant.');
            return { form:form.id, values:data.values, sheet:sheet.name, row:selection.rowIndex + 1, name };
        });
    }
    function showSelection(data) { $('selection').textContent = data.sheet + ' / Row ' + data.row; $('caseName').textContent = data.name; }
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
    async function refresh() {
        const current = ++revision;
        clearResult(); message('');
        try { const data = await readSelection(); if (current === revision) showSelection(data); }
        catch(error) { if (current === revision) { $('selection').textContent = 'No case selected'; $('caseName').textContent = ''; message(error.message); } }
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
            pdfUrl = URL.createObjectURL(blob);
            previewBlob = blob;
            const filename = data.form.toUpperCase() + '-row-' + data.row + '.pdf';
            for (const id of ['download', 'save']) { $(id).href = pdfUrl; $(id).download = filename; }
            $('resultName').textContent = data.name + ' / ' + filename; $('result').hidden = false;
            await renderPreview(blob);
            if (generationRevision !== revision) { clearResult(); message('The worksheet changed during generation. Generate the PDF again.'); return; }
            message('', 'PDF generated. Fillable fields retained.');
        } catch(error) { if (pdfUrl) message('PDF generated, but preview is unavailable. You can still download it.'); else message(error.message); }
        finally { busy = false; controls(); }
    });
    fetch('/excel/catalog').then(response => { if (!response.ok) throw new Error('Forms are unavailable.'); return response.json(); }).then(data => {
        forms = data; $('form').replaceChildren(...forms.map(form => { const option = document.createElement('option'); option.value = form.id; option.textContent = form.title; return option; })); controls();
    }).catch(error => message(error.message));
    if (window.lucide) lucide.createIcons();
    if (window.Office) Office.onReady(info => {
        officeReady = info.host === Office.HostType.Excel && Office.context.requirements.isSetSupported('ExcelApi', '1.7');
        controls();
        if (!officeReady) $('selection').textContent = 'Excel connection unavailable.';
        if (token) refresh();
        if (officeReady) Excel.run(async context => {
            const sheets = context.workbook.worksheets;
            sheets.load('items'); await context.sync();
            const changed = () => { ++revision; clearResult(); if (!busy && token) refresh(); };
            for (const sheet of sheets.items) {
                sheet.onSelectionChanged.add(changed);
                sheet.onChanged.add(changed);
                sheet.onActivated.add(changed);
            }
            await context.sync();
        }).catch(() => { /* Generate always reads the current selection even if host events are unavailable. */ });
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
