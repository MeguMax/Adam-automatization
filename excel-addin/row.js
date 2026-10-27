(function(root) {
    'use strict';
    function selectedFields(headers, row, types, form) {
        if (!Array.isArray(headers) || !Array.isArray(row) || !Array.isArray(types) || headers.length > 2048) throw new Error('The worksheet columns could not be read.');
        const values = {}, columns = {};
        for (const field of form.fields) {
            const matches = headers.flatMap((header, index) => header === field ? [index] : []);
            if (matches.length !== 1) throw new Error((matches.length ? 'Duplicate' : 'Missing') + ' column: ' + field);
            const index = matches[0], value = row[index];
            if (types[index] === 'Error') throw new Error('Excel error in ' + field + ': ' + value);
            if (value !== null && !['string', 'number', 'boolean'].includes(typeof value)) throw new Error('Unsupported cell in ' + field);
            if (typeof value === 'number' && !Number.isFinite(value)) throw new Error('Invalid number in ' + field);
            values[field] = value;
            columns[field] = index;
        }
        return { values, columns };
    }
    function assertSelection(selection) {
        if (!Number.isInteger(selection.rowIndex) || selection.rowCount !== 1 || selection.rowIndex < 1) throw new Error('Select one data row, not the header or multiple rows.');
    }
    function caseMetadata(headers, values, types) {
        function field(name, required = false) {
            const indexes = headers.flatMap((header, index) => header === name ? [index] : []);
            if (indexes.length > 1) throw new Error('Duplicate case column: ' + name);
            const index = indexes[0];
            if (index === undefined || values[index] === null || values[index] === undefined) {
                if (required) throw new Error('The selected row has no ' + name + '.');
                return '';
            }
            if (types[index] === 'Error') {
                if (required) throw new Error('Excel error in ' + name + '.');
                return '';
            }
            const value = String(values[index]).trim();
            if (required && !value) throw new Error('The selected row has no ' + name + '.');
            return value;
        }
        return {defendant:field('Defendant',true),plaintiff:field('Landlord'),court:field('Court_Name') || field('Court'),caseNumber:field('Case_Number')};
    }
    function isCalendarDate(value) {
        const match = typeof value === 'string' && value.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
        if (!match) return false;
        const month = Number(match[1]), day = Number(match[2]), year = Number(match[3]);
        const days = [31, year%4===0 && (year%100!==0 || year%400===0) ? 29 : 28,31,30,31,30,31,31,30,31,30,31];
        return year >= 1900 && month >= 1 && month <= 12 && day >= 1 && day <= days[month-1];
    }
    function pdfFilename(data) {
        const metadata = data.metadata || {};
        const parties = [metadata.plaintiff,metadata.defendant || data.name].filter(Boolean).join(' v ');
        const stem = [String(data.form).toUpperCase(),metadata.court,metadata.caseNumber,parties || 'row-'+data.row].filter(Boolean).join(' - ')
            .normalize('NFC').replace(/[<>:"/\\|?*\x00-\x1f]/g,'_').replace(/\s+/g,' ').trim().replace(/[. ]+$/g,'');
        return stem.slice(0,170).replace(/[. ]+$/g,'')+'.pdf';
    }
    const api = {selectedFields, assertSelection, caseMetadata, isCalendarDate, pdfFilename};
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
    else root.DevlinExcelRow = api;
})(globalThis);
