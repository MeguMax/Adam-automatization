(function(root) {
    'use strict';
    function validationError(issues) {
        return Object.assign(new Error(issues[0].message), {name:'ExcelSourceError',issues});
    }
    function columnName(index) {
        if (!Number.isInteger(index) || index < 0 || index >= 2048) throw new Error('Invalid worksheet column.');
        let name='',number=index+1;
        while(number>0){number--;name=String.fromCharCode(65+number%26)+name;number=Math.floor(number/26);}
        return name;
    }
    function selectedFields(headers, row, types, form) {
        if (!Array.isArray(headers) || !Array.isArray(row) || !Array.isArray(types) || headers.length > 2048) throw new Error('The worksheet columns could not be read.');
        const values = {}, columns = {}, issues = [];
        for (const field of form.fields) {
            const matches = headers.flatMap((header, index) => header === field ? [index] : []);
            if (matches.length !== 1) {
                issues.push({code:matches.length?'duplicate_column':'missing_column',field,columns:matches,
                    message:(matches.length?'Duplicate':'Missing')+' column: '+field});
                continue;
            }
            const index = matches[0], value = row[index];
            if (types[index] === 'Error' || typeof value === 'string' && /^#(?:REF!|VALUE!|DIV\/0!|N\/A|NAME\?|NUM!|NULL!|SPILL!|CALC!|BUSY!|GETTING_DATA)$/.test(value)) {
                issues.push({code:'excel_error',field,columns:[index],message:'Excel error in '+field+': '+String(value).slice(0,32)});
                continue;
            }
            if (value !== null && !['string', 'number', 'boolean'].includes(typeof value)) {
                issues.push({code:'unsupported_value',field,columns:[index],message:'Unsupported cell in '+field});continue;
            }
            if (typeof value === 'number' && !Number.isFinite(value)) {
                issues.push({code:'invalid_number',field,columns:[index],message:'Invalid number in '+field});continue;
            }
            values[field] = value;
            columns[field] = index;
        }
        if (issues.length) throw validationError(issues);
        return { values, columns };
    }
    function assertSelection(selection) {
        if (!Number.isInteger(selection.rowIndex) || selection.rowCount !== 1 || selection.rowIndex < 1) throw new Error('Select one data row, not the header or multiple rows.');
    }
    function caseMetadata(headers, values, types) {
        const issues=[];
        function field(name, required = false) {
            const indexes = headers.flatMap((header, index) => header === name ? [index] : []);
            if (indexes.length > 1) {
                issues.push({code:'duplicate_column',field:name,columns:indexes,message:'Duplicate case column: '+name});return '';
            }
            const index = indexes[0];
            if (index === undefined || values[index] === null || values[index] === undefined) {
                if (required) issues.push({code:index===undefined?'missing_column':'empty_identity',field:name,columns:index===undefined?[]:[index],message:'The selected row has no '+name+'.'});
                return '';
            }
            if (types[index] === 'Error') {
                if (required) issues.push({code:'excel_error',field:name,columns:[index],message:'Excel error in '+name+'.'});
                return '';
            }
            const value = String(values[index]).trim();
            if (required && !value) issues.push({code:'empty_identity',field:name,columns:[index],message:'The selected row has no '+name+'.'});
            return value;
        }
        const metadata={defendant:field('Defendant',true),plaintiff:field('Landlord'),court:field('Court_Name') || field('Court'),caseNumber:field('Case_Number')};
        if(issues.length)throw validationError(issues);
        return metadata;
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
    function downloadFilename(form, value) {
        if (!['dc105','dc508','mc202'].includes(form) || typeof value !== 'string') throw new Error('Enter a PDF file name.');
        let name = value.normalize('NFC').trim();
        if (!name || /[<>:"/\\|?*\x00-\x1f\x7f]/.test(name)) throw new Error('The file name is empty or contains characters that Windows cannot use.');
        if (/^(DC105|DC508|MC202)(?: - |\.pdf$)/i.test(name) && !name.toUpperCase().startsWith(form.toUpperCase() + ' - ')) {
            throw new Error('The file name refers to a different court form.');
        }
        if (/\.pdf$/i.test(name)) name = name.slice(0,-4) + '.pdf';
        else if (/\.[a-z0-9]{1,5}$/i.test(name)) throw new Error('The file must have a .pdf extension.');
        else name += '.pdf';
        if (name.slice(0,form.length + 3).toUpperCase() === form.toUpperCase() + ' - ') name = form.toUpperCase() + name.slice(form.length);
        else name = form.toUpperCase() + ' - ' + name;
        if (name.length > 174 || !name.slice(form.length + 3,-4).trim() || /[. ]\.pdf$/.test(name)) {
            throw new Error('The file name is too long or has an invalid ending.');
        }
        return name;
    }
    const api = {selectedFields, assertSelection, caseMetadata, isCalendarDate, pdfFilename, downloadFilename,validationError,columnName};
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
    else root.DevlinExcelRow = api;
})(globalThis);
