(function(root) {
    'use strict';
    const rowTools = typeof module !== 'undefined' && module.exports ? require('./row.js') : root.DevlinExcelRow;
    const MIN_EXCEL_API = '1.9';
    const expiredReads = new Set();

    function hostTimeout() {
        return Object.assign(new Error('Excel did not respond in time. Reopen PDF Forms if Refresh does not recover the connection.'),
            {code:'excel_host_timeout'});
    }
    async function boundedRead(excel, work, options) {
        if (expiredReads.size) throw hostTimeout();
        const timeout = options.hostTimeoutMs ?? 20000;
        if (!Number.isFinite(timeout) || timeout <= 0) throw new Error('Invalid Excel read deadline.');
        const now = options.now || Date.now, deadline = now() + timeout;
        const attempt = {expired:false};
        const check = () => { if (attempt.expired || expiredReads.size || now() >= deadline) throw hostTimeout(); };
        // Office requests cannot be canceled. Quarantine a timed-out read until it settles.
        const operation = Promise.resolve().then(() => excel.run(async context => {
            check();
            const sync = async () => { check(); await context.sync(); check(); };
            return work(context, sync);
        })).then(value => { check(); return value; }).finally(() => { expiredReads.delete(attempt); });
        let timer;
        try {
            return await Promise.race([operation, new Promise((_, reject) => {
                timer = setTimeout(() => { attempt.expired=true; expiredReads.add(attempt); reject(hostTimeout()); }, timeout);
            })]);
        } finally { clearTimeout(timer); }
    }

    async function readRows(excel, form, options = {}, batch = false) {
        const timeoutMs = options.timeoutMs ?? 15000;
        const sleep = options.sleep || (ms => new Promise(resolve => setTimeout(resolve, ms)));
        return boundedRead(excel, async (context, sync) => {
            const deadline = Date.now() + timeoutMs;
            const selection = context.workbook.getSelectedRange();
            selection.load('rowIndex,rowCount');
            const sheet = selection.worksheet;
            sheet.load('id,name');
            const used = sheet.getUsedRange(true);
            used.load('columnIndex,columnCount');
            if (options.recalculate !== false) context.application.calculate(excel.CalculationType.recalculate);
            await sync();
            if(batch) {
                if(!Number.isInteger(selection.rowIndex) || selection.rowIndex<1 || !Number.isInteger(selection.rowCount) ||
                    selection.rowCount<1 || selection.rowCount>10 || selection.rowIndex+selection.rowCount>1048576) {
                    throw new Error('Select between 1 and 10 adjacent data rows, without the header.');
                }
            } else rowTools.assertSelection(selection);
            const width = used.columnIndex + used.columnCount;
            if (!Number.isInteger(width) || width < 1 || width > 2048) throw new Error('The worksheet must have between 1 and 2,048 used columns.');
            const sourceError = (error,index=0) => Object.assign(error, {source:{sheet:sheet.name,sheetId:sheet.id,row:selection.rowIndex+index+1}});
            const headers = sheet.getRangeByIndexes(0, 0, 1, width);
            const rows=Array.from({length:selection.rowCount},(_,index)=>sheet.getRangeByIndexes(selection.rowIndex+index,0,1,width));
            // Wait for Excel itself; cached XLSX values and guessed date epochs are not used.
            let loaded=false;
            do {
                context.application.load('calculationState');
                await sync();
                if (context.application.calculationState === excel.CalculationState.done) {
                    headers.load('values'); rows.forEach(row=>row.load(batch?'values,valueTypes,rowHidden':'values,valueTypes'));
                    context.application.load('calculationState');
                    await sync();
                    if (context.application.calculationState === excel.CalculationState.done) {
                        loaded=true;
                        break;
                    }
                }
                if (Date.now() >= deadline) throw new Error('Excel is still calculating. Wait for calculation to finish, then try again.');
                await sleep(100);
            } while (Date.now() < deadline);
            if (!loaded) throw new Error('Excel did not finish calculating in time.');
            const dates=[],records=rows.map((row,index)=>{
                const record={row:selection.rowIndex+index+1,data:null,error:null,dateIssues:[]};
                try {
                    if(batch && row.rowHidden===true)throw Object.assign(new Error('Hidden row skipped.'),{code:'hidden_row'});
                    const raw=row.values[0],types=row.valueTypes[0];
                    const data=rowTools.selectedFields(headers.values[0],raw,types,form);
                    const metadata=rowTools.caseMetadata(headers.values[0],raw,types);
                    record.data={form:form.id,values:data.values,columns:data.columns,sheet:sheet.name,sheetId:sheet.id,
                        row:record.row,name:metadata.defendant,metadata};
                    for(const field of form.dateFields)if(typeof data.values[field]==='number') {
                        if(!Number.isInteger(data.values[field])) {
                            record.dateIssues.push({code:'invalid_date',field,columns:[data.columns[field]],message:'Time-bearing date in '+field+' requires review.'});continue;
                        }
                        const cell=row.getCell(0,data.columns[field]);
                        const parts=['month','day','year'].map(name=>{const value=context.workbook.functions[name](cell);value.load('value');return value;});
                        dates.push({record,field,parts});
                    }
                }catch(error){record.error=sourceError(error,index);}
                return record;
            });
            if(dates.length)await sync();
            for(const date of dates) {
                const parts=date.parts.map(part=>part.value),formatted=parts.join('/');
                if(!parts.every(Number.isInteger) || !rowTools.isCalendarDate(formatted)) {
                    date.record.dateIssues.push({code:'invalid_date',field:date.field,columns:[date.record.data.columns[date.field]],
                        message:'Excel could not read '+date.field+' as a calendar date.'});
                }else date.record.data.values[date.field]=formatted;
            }
            records.forEach((record,index)=>{if(record.dateIssues.length)record.error=sourceError(rowTools.validationError(record.dateIssues),index);});
            context.application.load('calculationState');
            const current = context.workbook.getSelectedRange();
            current.load('rowIndex,rowCount'); current.worksheet.load('id');
            await sync();
            if (current.rowIndex !== selection.rowIndex || current.rowCount !== selection.rowCount || current.worksheet.id !== sheet.id ||
                context.application.calculationState !== excel.CalculationState.done) {
                throw new Error('The worksheet changed while reading the case. Select the row and try again.');
            }
            if(!batch) {
                if(records[0].error)throw records[0].error;
                return records[0].data;
            }
            return {sheet:sheet.name,sheetId:sheet.id,startRow:selection.rowIndex+1,rowCount:selection.rowCount,
                rows:records.map(record=>record.error ? {row:record.row,data:null,error:{message:record.error.message,
                    code:record.error.code || 'source',issues:record.error.issues || [],source:record.error.source}} : {row:record.row,data:record.data,error:null})};
        }, options);
    }
    async function readSelection(excel,form,options={}) {return readRows(excel,form,options);}
    async function selectSource(excel, source) {
        if (!source || typeof source.sheetId!=='string' || !source.sheetId ||
            !Number.isInteger(source.row) || source.row<1 || source.row>1048576 ||
            !Number.isInteger(source.column) || source.column<0 || source.column>=2048) {
            throw new Error('The source cell is no longer available. Refresh the selected row.');
        }
        await excel.run(async context=>{
            const sheet=context.workbook.worksheets.getItem(source.sheetId);
            sheet.activate();sheet.getRangeByIndexes(source.row-1,source.column,1,1).select();
            await context.sync();
        });
    }
    function sameSnapshot(left, right) {
        if (!left || !right) return false;
        return left.form === right.form && left.sheetId === right.sheetId && left.sheet === right.sheet && left.row === right.row &&
            left.name === right.name && JSON.stringify(left.values) === JSON.stringify(right.values) &&
            JSON.stringify(left.metadata) === JSON.stringify(right.metadata);
    }
    async function readPackage(excel, forms, options = {}) {
        if (!Array.isArray(forms) || forms.length !== 3 ||
            ['dc105','dc508','mc202'].some(id => forms.filter(form => form.id === id).length !== 1)) {
            throw new Error('All three court forms must be available.');
        }
        // One calculation and one row read for all 101 fields, not three independent selections.
        return readSelection(excel, {id:'package', fields:forms.flatMap(form => form.fields),
            dateFields:forms.flatMap(form => form.dateFields)}, options);
    }
    async function readBatch(excel,forms,options={}) {
        if(!Array.isArray(forms) || !forms.length || forms.length>3 || new Set(forms.map(form=>form.id)).size!==forms.length ||
            forms.some(form=>!['dc105','dc508','mc202'].includes(form.id)))throw new Error('Choose one or more court forms.');
        return {...await readRows(excel,{id:'batch',fields:forms.flatMap(form=>form.fields),dateFields:forms.flatMap(form=>form.dateFields)},options,true),
            formIds:forms.map(form=>form.id)};
    }
    function sameBatchSnapshot(left,right) {return Boolean(left && right && JSON.stringify(left)===JSON.stringify(right));}
    const api = {MIN_EXCEL_API, readSelection, readPackage, readBatch, sameBatchSnapshot, sameSnapshot, selectSource};
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
    else root.DevlinExcelWorkbook = api;
})(globalThis);
