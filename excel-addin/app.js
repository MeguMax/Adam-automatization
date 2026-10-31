(function() {
    'use strict';
    const $ = id => document.getElementById(id);
    let token = '', forms = [], officeReady = false, busy = false, pdfUrl = '', revision = 0, pdfTask = null, previewBlob = null, previewWidth = 0;
    let selectedData = null, resultSnapshot = null, refreshTimer;
    let generationId = '', deliveryAvailable = false, savedCopy = null;
    let filenameOwner = '', resultFilename = '';
    let packageUrl = '', packageSnapshot = null, packageFilename = '';
    const FORM_KEY = 'devlin.excel.form.v1';
    let storage;
    try { storage = window.localStorage; } catch { /* Excel may disable persistent browser storage. */ }
    const sessions = DevlinExcelSession.create(storage);
    let connecting = false, connectionRevision = 0, expiryTimer, resumePending = false;
    let catalogBusy = false, catalogError = '';
    function message(error, status = '') {
        $('error').textContent = error; $('status').textContent = status;
        $('sourceIssues').hidden=true; $('sourceIssueList').replaceChildren();
    }
    function controls() {
        $('catalogState').hidden = !officeReady || (!catalogBusy && !catalogError);
        $('retryCatalog').hidden = !catalogError;
        $('retryCatalog').disabled = catalogBusy;
        $('generate').disabled = busy || connecting || !officeReady || !token || !forms.length || !selectedData;
        $('generatePackage').disabled = busy || connecting || !officeReady || !token || forms.length !== 3 || !selectedData;
        $('downloadPackage').setAttribute('aria-disabled', String(busy || !packageUrl));
        $('refresh').disabled = busy || !officeReady; $('form').disabled = busy || !forms.length;
        $('filename').disabled = busy || !selectedData; $('resetFilename').disabled = busy || !selectedData;
        for (const id of ['download','save']) $(id).setAttribute('aria-disabled',String(busy || !pdfUrl));
        $('back').disabled = busy;
        $('autoSave').disabled = busy;
        $('saveCloud').disabled = busy || !generationId || !!savedCopy;
        $('saveCloud').querySelector('span').textContent = savedCopy ? 'Saved to OneDrive' : 'Save to OneDrive';
        $('sourceIssueList').querySelectorAll('button').forEach(button=>{button.disabled=busy || !officeReady || !token;});
    }
    function clearResult() {
        if (packageUrl) URL.revokeObjectURL(packageUrl);
        packageUrl = ''; packageSnapshot = null; packageFilename = '';
        $('packageResult').hidden = true; $('packageFiles').replaceChildren();
        $('downloadPackage').removeAttribute('href'); $('downloadPackage').removeAttribute('download');
        if (pdfUrl) URL.revokeObjectURL(pdfUrl);
        pdfUrl = ''; previewBlob = null; resultSnapshot = null; resultFilename = '';
        generationId = ''; savedCopy = null; $('openCloud').hidden = true; $('openCloud').removeAttribute('href');
        if (pdfTask) pdfTask.destroy().catch(() => {});
        pdfTask = null; $('preview').replaceChildren(); $('result').hidden = true;
        for (const id of ['download','save']) { $(id).removeAttribute('href'); $(id).removeAttribute('download'); }
    }
    function signedOut() {
        ++revision; ++connectionRevision; token = ''; connecting = false; sessions.clear(); clearTimeout(expiryTimer);
        selectedData = null; deliveryAvailable = false; $('autoSave').checked = false; $('deliveryOptions').hidden = true;
        filenameOwner = ''; $('filename').value = ''; $('fileNaming').hidden = true;
        $('cloudActions').hidden = true; clearResult(); $('workspace').hidden = true; $('connection').hidden = true;
        $('signIn').hidden = !officeReady; $('logout').hidden = true; controls();
    }
    function watchExpiry(expiresAt) {
        clearTimeout(expiryTimer);
        expiryTimer = setTimeout(() => { signedOut(); message('Your 12-hour Excel connection expired. Connect again.'); }, Math.max(0, expiresAt - Date.now()));
    }
    async function api(url, data) {
        const owner = token;
        const abort = new AbortController();
        // Include response-body reads in the deadline, not only the HTTP headers.
        const timer = setTimeout(() => abort.abort(), url === '/excel/generate-package' ? 105000 : url === '/excel/generate' ? 45000 : url === '/excel/save' ? 55000 : 20000);
        try {
            const response = await fetch(url, { method:'POST', credentials:'omit', signal:abort.signal,
                headers:{'Content-Type':'application/json', ...(token ? { Authorization:'Bearer ' + token } : {})}, body:JSON.stringify(data) });
            if (!response.ok) {
                let result;
                try { result = await response.json(); } catch(error) { if (abort.signal.aborted) throw error; }
                if (response.status === 401 && token && token === owner) signedOut();
                const error = new Error(result?.error || (response.status >= 500 ? 'The PDF service is temporarily unavailable. Try again shortly.' : 'Request failed. Please try again.'));
                error.status = response.status;
                if (typeof result?.field === 'string') error.field = result.field;
                throw error;
            }
            if (url === '/excel/generate-package') {
                if (!response.headers.get('content-type')?.includes('application/zip')) throw new Error('The PDF service returned an unexpected ZIP response.');
                const blob = await response.blob();
                if (blob.size < 22 || (await blob.slice(0,2).text()) !== 'PK') throw new Error('The generated ZIP is invalid.');
                return {blob};
            }
            if (url !== '/excel/generate') return await response.json();
            if (!response.headers.get('content-type')?.includes('application/pdf')) throw new Error('The PDF service returned an unexpected response. Please try again.');
            const blob = await response.blob();
            if ((await blob.slice(0,5).text()) !== '%PDF-') throw new Error('The generated PDF is invalid. Please try again.');
            return { blob, generationId:response.headers.get('x-excel-generation-id') || '' };
        } catch(error) {
            if (abort.signal.aborted) throw new Error('The request timed out. Check your connection, then try again.');
            if (error instanceof TypeError) throw new Error('Could not reach the PDF service. Check your connection and try again.');
            throw error;
        } finally { clearTimeout(timer); }
    }
    async function readSelection(options = {}) {
        if (!officeReady) throw new Error('Excel connection unavailable.');
        const form = forms.find(item => item.id === $('form').value);
        if (!form) throw new Error('Select a court form.');
        return DevlinExcelWorkbook.readSelection(Excel,form,options);
    }
    function showSelection(data) {
        selectedData = data;
        const owner = JSON.stringify([data.sheetId, data.row, data.form, data.metadata]);
        if (owner !== filenameOwner) {
            filenameOwner = owner; $('filename').value = DevlinExcelRow.pdfFilename(data); $('filename').removeAttribute('aria-invalid');
        }
        $('fileNaming').hidden = false;
        $('selection').textContent = data.sheet + ' / Row ' + data.row;
        $('caseName').textContent = data.name;
        $('caseContext').textContent = [data.metadata.plaintiff,data.metadata.court,data.metadata.caseNumber].filter(Boolean).join(' / ');
    }
    function sourceError(error, data) {
        const context=error.source || data, issue=error.issues?.[0];
        const index=issue?.columns?.[0] ?? data?.columns?.[error.field];
        if(!context || !Number.isInteger(index) || index<0 || index>=2048)return error.message;
        const row=issue && ['missing_column','duplicate_column'].includes(issue.code) ? 1 : context.row;
        return error.message.replace(/[. ]+$/,'') + '. Source: ' + context.sheet + ' / ' + DevlinExcelRow.columnName(index) + row + '.';
    }
    function showSourceError(error, data) {
        message(sourceError(error,data));
        const context=error.source || data;
        const issues=error.issues || (error.field && Number.isInteger(data?.columns?.[error.field]) ?
            [{field:error.field,columns:[data.columns[error.field]],message:error.message,code:'pdf_field'}] : []);
        if(!context || !issues.length)return;
        $('sourceIssuesTitle').textContent='Source issues ('+issues.length+')';
        for(const issue of issues.slice(0,110)) {
            const item=document.createElement('li'), label=document.createElement('div');label.textContent=issue.message;item.append(label);
            const cells=document.createElement('div');cells.className='source-cells';
            const location=document.createElement('span');location.textContent=context.sheet+' / ';cells.append(location);
            const row=['missing_column','duplicate_column'].includes(issue.code)?1:context.row;
            const columns=issue.columns.length?issue.columns.slice(0,5):[0];
            for(const column of columns) {
                const address=DevlinExcelRow.columnName(column)+row, button=document.createElement('button');
                button.type='button';button.className='source-cell';button.title='Select cell '+address;button.setAttribute('aria-label','Select cell '+address);
                const icon=document.createElement('i');icon.setAttribute('data-lucide','arrow-up-right');
                const text=document.createElement('span');text.textContent=issue.columns.length?address:'Header row';button.append(icon,text);
                button.addEventListener('click',async()=>{
                    if(busy || !token || !officeReady)return;
                    busy=true;controls();
                    try {await DevlinExcelWorkbook.selectSource(Excel,{sheetId:context.sheetId,row,column});}
                    catch {message('The source cell could not be selected. Refresh the selected row and try again.');}
                    finally {busy=false;controls();if(token)await refresh(true,{recalculate:false});}
                });
                cells.append(button);
            }
            if(issue.columns.length>columns.length){const rest=document.createElement('span');rest.textContent='+'+(issue.columns.length-columns.length)+' more';cells.append(rest);}
            item.append(cells);$('sourceIssueList').append(item);
        }
        $('sourceIssues').hidden=false;if(window.lucide)lucide.createIcons();controls();
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
    async function refresh(keepMessage = false, readOptions = {}) {
        const current = ++revision;
        selectedData = null; clearResult(); controls();
        if (!officeReady || !forms.length) {
            $('selection').textContent = 'Waiting for court forms'; $('caseName').textContent = ''; $('caseContext').textContent = ''; $('fileNaming').hidden = true;
            return;
        }
        if (keepMessage !== true) message('');
        try { const data = await readSelection(readOptions); if (current === revision) showSelection(data); }
        catch(error) { if (current === revision) { $('selection').textContent = 'No case selected'; $('caseName').textContent = ''; $('caseContext').textContent = ''; $('fileNaming').hidden = true; showSourceError(error); } }
        finally { controls(); }
    }
    async function loadDelivery() {
        const owner = token;
        deliveryAvailable = false;
        $('result').classList.remove('has-delivery');
        $('deliveryOptions').hidden = true; $('cloudActions').hidden = true;
        try {
            const destination = await api('/excel/delivery', {});
            if (!token || token !== owner) return;
            deliveryAvailable = destination.available === true;
            $('deliveryOptions').hidden = !deliveryAvailable;
            $('cloudActions').hidden = !deliveryAvailable;
            $('result').classList.toggle('has-delivery',deliveryAvailable);
            $('destination').textContent = deliveryAvailable ? destination.name : '';
        } catch { /* Optional delivery must not prevent local PDF generation. */ }
        controls();
    }
    async function saveToCloud() {
        const source = resultSnapshot, id = generationId, current = revision;
        if (!source || !id) throw new Error('Generate the PDF again before saving to OneDrive.');
        message('', 'Checking current row before saving...');
        let latest;
        try { latest = await readSelection({recalculate:false}); }
        catch(error) { clearResult(); selectedData = null; throw error; }
        if (!token || current !== revision || id !== generationId || !DevlinExcelWorkbook.sameSnapshot(source,latest)) {
            clearResult(); selectedData = null;
            throw new Error('The worksheet changed since this PDF was generated. Generate the PDF again.');
        }
        message('', 'Saving to OneDrive...');
        const saved = await api('/excel/save', {generationId:id});
        if (current !== revision || generationId !== id) {
            message('', 'The previous PDF was saved to OneDrive. The current row has changed.'); return;
        }
        const url = new URL(saved.url);
        if (url.protocol !== 'https:') throw new Error('OneDrive did not return a valid file link.');
        savedCopy = saved; $('openCloud').href = url.href; $('openCloud').hidden = false;
        message('', 'PDF saved to OneDrive. Fillable fields retained.');
    }
    async function connected(value, expiresIn) {
        const saved = sessions.write(value, expiresIn);
        token = saved.token; connecting = false; watchExpiry(saved.expiresAt);
        $('password').value = ''; $('signIn').hidden = true; $('connection').hidden = true;
        $('workspace').hidden = false; $('logout').hidden = false;
        message(''); controls(); await refresh(); await loadDelivery();
    }
    async function reconnect() {
        if (!officeReady || resumePending) return;
        const saved = sessions.read();
        if (!saved) { signedOut(); return; }
        const attempt = ++connectionRevision;
        token = saved.token; connecting = true; watchExpiry(saved.expiresAt);
        $('signIn').hidden = true; $('workspace').hidden = true; $('connection').hidden = false;
        $('logout').hidden = false; $('reconnect').disabled = true;
        resumePending = true; controls(); message('', 'Restoring connection...');
        try {
            const session = await api('/excel/resume', {});
            if (attempt !== connectionRevision || token !== saved.token) return;
            await connected(saved.token, session.expiresIn);
        } catch(error) {
            if (error.status === 401 || attempt === connectionRevision) message(error.message);
        } finally { resumePending = false; $('reconnect').disabled = false; }
    }
    $('loginForm').addEventListener('submit', async event => {
        event.preventDefault(); $('login').disabled = true; message('');
        try {
            if (!officeReady) throw new Error('Open the panel in a supported Excel workbook.');
            const session = await api('/excel/session', { username:$('username').value, password:$('password').value });
            await connected(session.token, session.expiresIn);
        } catch(error) { message(error.message); }
        finally { $('login').disabled = false; }
    });
    $('logout').addEventListener('click', async () => {
        const request = api('/excel/logout', {});
        signedOut(); message('');
        try { await request; } catch { /* Local access is already cleared if the network is unavailable. */ }
    });
    $('reconnect').addEventListener('click', reconnect);
    $('refresh').addEventListener('click', refresh);
    $('form').addEventListener('change', () => {
        try { storage?.setItem(FORM_KEY, $('form').value); } catch { /* Form selection remains usable without browser storage. */ }
        refresh();
    });
    $('filename').addEventListener('input', () => { ++revision; clearResult(); $('filename').removeAttribute('aria-invalid'); message(''); controls(); });
    $('resetFilename').addEventListener('click', () => {
        if (!selectedData) return;
        ++revision; clearResult(); $('filename').value = DevlinExcelRow.pdfFilename(selectedData);
        $('filename').removeAttribute('aria-invalid'); message(''); controls();
    });
    $('back').addEventListener('click', () => {
        clearResult(); message(''); controls();
        $('workspace').scrollIntoView({block:'start'}); $('form').focus({preventScroll:true});
    });
    $('generate').addEventListener('click', async () => {
        if (busy) return;
        clearTimeout(refreshTimer);
        const generationRevision = ++revision;
        let source = null;
        busy = true; controls(); clearResult(); message('', 'Reading selected row...');
        try {
            // Read again here, never reuse a preview snapshot after a worksheet edit.
            const data = await readSelection(); source = data; showSelection(data);
            let filename;
            try { filename = DevlinExcelRow.downloadFilename(data.form, $('filename').value); }
            catch(error) { $('filename').setAttribute('aria-invalid','true'); throw error; }
            $('filename').value = filename;
            message('', 'Generating PDF...');
            const generated = await api('/excel/generate', { form:data.form, values:data.values, filename });
            const blob = generated.blob;
            if (!token) return;
            if (generationRevision !== revision) { message('The worksheet changed during generation. Generate the PDF again.'); return; }
            const currentData = await readSelection({recalculate:false});
            if (generationRevision !== revision || !DevlinExcelWorkbook.sameSnapshot(data,currentData)) {
                selectedData = null; message('The worksheet changed during generation. Generate the PDF again.'); return;
            }
            pdfUrl = URL.createObjectURL(blob);
            previewBlob = blob;
            resultSnapshot = data;
            resultFilename = filename;
            generationId = generated.generationId;
            for (const id of ['download', 'save']) { $(id).href = pdfUrl; $(id).download = filename; }
            $('resultName').textContent = data.name + ' / ' + filename; $('result').hidden = false;
            await renderPreview(blob);
            if (generationRevision !== revision) { clearResult(); message('The worksheet changed during generation. Generate the PDF again.'); return; }
            message('', 'PDF generated. Fillable fields retained.');
            $('result').scrollIntoView({block:'start'});
            if (deliveryAvailable && $('autoSave').checked) {
                try { await saveToCloud(); }
                catch(error) { message(error.message, pdfUrl ? 'PDF ready. You can still download it or retry saving.' : ''); }
            }
        } catch(error) { if (pdfUrl) message('PDF generated, but preview is unavailable. You can still download it.'); else showSourceError(error, source); }
        finally { busy = false; controls(); if (!selectedData && token) refresh(true); }
    });
    $('generatePackage').addEventListener('click', async () => {
        if (busy) return;
        clearTimeout(refreshTimer);
        const current = ++revision;
        busy = true; clearResult(); controls(); message('', 'Reading all three forms from the selected row...');
        let source = null;
        try {
            source = await DevlinExcelWorkbook.readPackage(Excel, forms);
            if (!token || current !== revision) throw new Error('The worksheet changed. Generate the package again.');
            const items = forms.map(form => ({form:form.id,
                filename:DevlinExcelRow.pdfFilename({...source,form:form.id}),
                values:Object.fromEntries(form.fields.map(field => [field,source.values[field]]))}));
            message('', 'Generating DC105, DC508 and MC202...');
            const {blob} = await api('/excel/generate-package', {forms:items});
            if (!token) return;
            const latest = await DevlinExcelWorkbook.readPackage(Excel, forms, {recalculate:false});
            if (current !== revision || !DevlinExcelWorkbook.sameSnapshot(source, latest)) {
                selectedData = null; throw new Error('The worksheet changed during generation. Generate the package again.');
            }
            packageSnapshot = source; packageUrl = URL.createObjectURL(blob);
            packageFilename = DevlinExcelRow.pdfFilename({...source,form:'Forms'}).replace(/\.pdf$/i,'.zip');
            $('packageFiles').replaceChildren(...items.map(item => { const li=document.createElement('li'); li.textContent=item.filename; return li; }));
            $('downloadPackage').href = packageUrl; $('downloadPackage').download = packageFilename;
            $('packageResult').hidden = false;
            message('', 'All 3 fillable PDFs are ready in one ZIP.');
            $('packageResult').scrollIntoView({block:'nearest'});
        } catch(error) { clearResult(); showSourceError(error,source); }
        finally { busy=false; controls(); if (!selectedData && token) refresh(true); }
    });
    $('downloadPackage').addEventListener('click', async event => {
        event.preventDefault();
        if (busy || !packageUrl || !packageSnapshot) return;
        const source=packageSnapshot, url=packageUrl, current=revision;
        busy=true; controls(); message('', 'Checking current row...');
        try {
            const latest = await DevlinExcelWorkbook.readPackage(Excel,forms,{recalculate:false});
            if (!token || current!==revision || url!==packageUrl || !DevlinExcelWorkbook.sameSnapshot(source,latest)) {
                selectedData=null; throw new Error('The worksheet changed since this ZIP was generated. Generate the package again.');
            }
            const link=document.createElement('a'); link.href=url; link.download=packageFilename;
            document.body.append(link); link.click(); link.remove(); message('', 'ZIP download requested. All 3 PDFs remain fillable.');
        } catch(error) {clearResult(); message(error.message);}
        finally {busy=false; controls(); if (!selectedData && token) refresh(true);}
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
            const link = document.createElement('a'); link.href = url; link.download = resultFilename;
            document.body.append(link); link.click(); link.remove();
            message('', 'PDF download requested. Fillable fields retained.');
        } catch(error) { clearResult(); message(error.message); }
        finally { busy = false; controls(); if (!selectedData && token) refresh(true); }
    }
    $('download').addEventListener('click',download);
    $('save').addEventListener('click',download);
    $('saveCloud').addEventListener('click',async () => {
        if (busy || savedCopy || !deliveryAvailable) return;
        busy = true; controls();
        try { await saveToCloud(); }
        catch(error) { message(error.message, pdfUrl ? 'PDF ready. You can still download it or retry saving.' : ''); }
        finally { busy = false; controls(); if (!selectedData && token) refresh(true); }
    });
    async function loadCatalog() {
        if (catalogBusy) return;
        catalogBusy = true; catalogError = ''; $('catalogStatus').textContent = 'Loading court forms...'; controls();
        if (!forms.length) $('form').options[0].text = 'Loading forms...';
        let loaded = false;
        const abort = new AbortController(), timer = setTimeout(() => abort.abort(), 20000);
        try {
            const response = await fetch('/excel/catalog', {credentials:'omit', signal:abort.signal});
            if (!response.ok) throw new Error('Forms are unavailable. Check your connection and reload forms.');
            const data = await response.json();
            if (!Array.isArray(data) || data.length !== 3 || new Set(data.map(form => form?.id)).size !== 3 || data.some(form =>
                !['dc105','dc508','mc202'].includes(form?.id) || typeof form.title !== 'string' || !form.title || form.title.length > 120 ||
                !Array.isArray(form.fields) || !form.fields.length || form.fields.length > 200 || new Set(form.fields).size !== form.fields.length ||
                form.fields.some(field => typeof field !== 'string' || !/^[a-z0-9]+_\d{2}$/.test(field)) ||
                !Array.isArray(form.dateFields) || form.dateFields.some(field => !form.fields.includes(field)))) {
                throw new Error('The forms list is invalid. Reload forms to try again.');
            }
            forms = data; $('form').replaceChildren(...forms.map(form => { const option = document.createElement('option'); option.value = form.id; option.textContent = form.title; return option; }));
            try { const previous = storage?.getItem(FORM_KEY); if (forms.some(form => form.id === previous)) $('form').value = previous; } catch { /* Use the first available form. */ }
            loaded = true;
        } catch(error) {
            catalogError = abort.signal.aborted ? 'Loading forms timed out. Reload forms to try again.' :
                error instanceof TypeError ? 'Forms are unavailable. Check your connection and reload forms.' :
                error instanceof SyntaxError ? 'The forms list is invalid. Reload forms to try again.' : error.message;
            $('catalogStatus').textContent = catalogError;
            if (!forms.length) $('form').options[0].text = 'Forms unavailable';
        } finally { clearTimeout(timer); catalogBusy = false; controls(); }
        if (loaded && token && !connecting && officeReady) refresh();
    }
    $('retryCatalog').addEventListener('click', loadCatalog);
    $('reloadHost').addEventListener('click', () => window.location.reload());
    window.addEventListener('online', () => {
        if (catalogError) loadCatalog();
        if (token && connecting && !resumePending) reconnect();
    });
    loadCatalog();
    if (window.lucide) lucide.createIcons();
    function hostUnavailable(title, detail) {
        $('hostTitle').textContent = title; $('hostMessage').textContent = detail;
        $('hostNotice').hidden = false; $('hostActions').hidden = false;
    }
    const hostTimer = setTimeout(() => {
        if (!officeReady) hostUnavailable('Excel connection unavailable', 'Excel did not finish connecting. Reload the panel to try again.');
    }, 20000);
    if (window.Office) Promise.resolve(Office.onReady(info => {
        clearTimeout(hostTimer);
        officeReady = info.host === Office.HostType.Excel && Office.context.requirements.isSetSupported('ExcelApi', DevlinExcelWorkbook.MIN_EXCEL_API);
        $('hostNotice').hidden = officeReady;
        controls();
        if (!officeReady) {
            hostUnavailable(info.host === Office.HostType.Excel ? 'Update Excel' : 'Open in Excel', info.host === Office.HostType.Excel ?
                'Excel API '+DevlinExcelWorkbook.MIN_EXCEL_API+' or newer is required. Use a current Microsoft 365 version of Excel.' :
                'No Excel workbook is connected to this browser tab.');
            return;
        }
        reconnect();
        if (officeReady) Excel.run(async context => {
            const sheets = context.workbook.worksheets;
            const changed = () => {
                ++revision; selectedData = null; clearResult(); controls(); clearTimeout(refreshTimer);
                if (!busy && token && !connecting) refreshTimer = setTimeout(() => refresh(),150);
            };
            sheets.onSelectionChanged.add(changed);
            sheets.onChanged.add(changed);
            sheets.onActivated.add(changed);
            sheets.onAdded.add(changed);
            sheets.onDeleted.add(changed);
            await context.sync();
        }).catch(() => { /* Before/after generation and download rechecks also protect hosts without change events. */ });
    })).catch(() => { clearTimeout(hostTimer); hostUnavailable('Excel connection unavailable', 'Reload the panel to try again.'); });
    else { clearTimeout(hostTimer); hostUnavailable('Excel connection unavailable', 'The Office library did not load. Check your connection and reload the panel.'); }
    window.addEventListener('beforeunload', () => { if (pdfUrl) URL.revokeObjectURL(pdfUrl); if (packageUrl) URL.revokeObjectURL(packageUrl); });
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
