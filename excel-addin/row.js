(function(root) {
    'use strict';
    function selectedFields(headers, row, types, form) {
        if (!Array.isArray(headers) || !Array.isArray(row) || headers.length > 2048) throw new Error('The worksheet columns could not be read.');
        const values = {}, columns = {};
        for (const field of form.fields) {
            const matches = headers.flatMap((header, index) => header === field ? [index] : []);
            if (matches.length !== 1) throw new Error((matches.length ? 'Duplicate' : 'Missing') + ' column: ' + field);
            const index = matches[0], value = row[index];
            if (types[index] === 'Error') throw new Error('Excel error in ' + field + ': ' + value);
            if (value !== null && !['string', 'number', 'boolean'].includes(typeof value)) throw new Error('Unsupported cell in ' + field);
            values[field] = value;
            columns[field] = index;
        }
        return { values, columns };
    }
    function assertSelection(selection) {
        if (selection.rowCount !== 1 || selection.rowIndex < 1) throw new Error('Select one data row, not the header or multiple rows.');
    }
    const api = { selectedFields, assertSelection };
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
    else root.DevlinExcelRow = api;
})(globalThis);
