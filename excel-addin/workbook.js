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
                const formatted = context.workbook.functions.text(row.getCell(0, data.columns[field]), 'm/d/yyyy');
                formatted.load('value'); dates.push({field, formatted});
            }
            if (dates.length) await context.sync();
            for (const date of dates) {
                if (!rowTools.isCalendarDate(date.formatted.value)) throw new Error('Excel could not format ' + date.field + ' as a calendar date.');
                data.values[date.field] = date.formatted.value;
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
            return {form:form.id, values:data.values, sheet:sheet.name, sheetId:sheet.id,
                row:selection.rowIndex+1, name:metadata.defendant, metadata};
        });
    }
    function sameSnapshot(left, right) {
        if (!left || !right) return false;
        return left.form === right.form && left.sheetId === right.sheetId && left.sheet === right.sheet && left.row === right.row &&
            left.name === right.name && JSON.stringify(left.values) === JSON.stringify(right.values) &&
            JSON.stringify(left.metadata) === JSON.stringify(right.metadata);
    }
    const api = {MIN_EXCEL_API, readSelection, sameSnapshot};
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
    else root.DevlinExcelWorkbook = api;
})(globalThis);
