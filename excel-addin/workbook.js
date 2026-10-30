(function(root) {
    'use strict';
    const rowTools = typeof module !== 'undefined' && module.exports ? require('./row.js') : root.DevlinExcelRow;
    const MIN_EXCEL_API = '1.9';

    async function readSelection(excel, form, options = {}) {
        const timeoutMs = options.timeoutMs ?? 15000;
        const sleep = options.sleep || (ms => new Promise(resolve => setTimeout(resolve, ms)));
        return excel.run(async context => {
            const deadline = Date.now() + timeoutMs;
            const selection = context.workbook.getSelectedRange();
            selection.load('rowIndex,rowCount');
            const sheet = selection.worksheet;
            sheet.load('id,name');
            const used = sheet.getUsedRange(true);
            used.load('columnIndex,columnCount');
            if (options.recalculate !== false) context.application.calculate(excel.CalculationType.recalculate);
            await context.sync();
            rowTools.assertSelection(selection);
            const width = used.columnIndex + used.columnCount;
            if (!Number.isInteger(width) || width < 1 || width > 2048) throw new Error('The worksheet must have between 1 and 2,048 used columns.');
            const headers = sheet.getRangeByIndexes(0, 0, 1, width);
            const row = sheet.getRangeByIndexes(selection.rowIndex, 0, 1, width);
            // Wait for Excel itself; cached XLSX values and guessed date epochs are not used.
            let data;
            do {
                context.application.load('calculationState');
                await context.sync();
                if (context.application.calculationState === excel.CalculationState.done) {
                    headers.load('values'); row.load('values,valueTypes');
                    context.application.load('calculationState');
                    await context.sync();
                    if (context.application.calculationState === excel.CalculationState.done) {
                        data = rowTools.selectedFields(headers.values[0], row.values[0], row.valueTypes[0], form);
                        break;
                    }
                }
                if (Date.now() >= deadline) throw new Error('Excel is still calculating. Wait for calculation to finish, then try again.');
                await sleep(100);
            } while (Date.now() < deadline);
            if (!data) throw new Error('Excel did not finish calculating in time.');
            const dates = [];
            for (const field of form.dateFields) if (typeof data.values[field] === 'number') {
                if (!Number.isInteger(data.values[field])) throw new Error('Time-bearing date in ' + field + ' requires review.');
                // TEXT's date-format tokens vary by Office locale. Let Excel resolve the calendar components.
                const cell = row.getCell(0, data.columns[field]);
                const parts = ['month','day','year'].map(name => {
                    const result = context.workbook.functions[name](cell);
                    result.load('value'); return result;
                });
                dates.push({field, parts});
            }
            if (dates.length) await context.sync();
            for (const date of dates) {
                const parts = date.parts.map(part => part.value);
                const formatted = parts.join('/');
                if (!parts.every(Number.isInteger) || !rowTools.isCalendarDate(formatted)) throw new Error('Excel could not read ' + date.field + ' as a calendar date.');
                data.values[date.field] = formatted;
            }
            const metadata = rowTools.caseMetadata(headers.values[0], row.values[0], row.valueTypes[0]);
            context.application.load('calculationState');
            const current = context.workbook.getSelectedRange();
            current.load('rowIndex,rowCount'); current.worksheet.load('id');
            await context.sync();
            if (current.rowIndex !== selection.rowIndex || current.rowCount !== 1 || current.worksheet.id !== sheet.id ||
                context.application.calculationState !== excel.CalculationState.done) {
                throw new Error('The worksheet changed while reading the case. Select the row and try again.');
            }
            return {form:form.id, values:data.values, columns:data.columns, sheet:sheet.name, sheetId:sheet.id,
                row:selection.rowIndex+1, name:metadata.defendant, metadata};
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
    const api = {MIN_EXCEL_API, readSelection, readPackage, sameSnapshot};
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
    else root.DevlinExcelWorkbook = api;
})(globalThis);
