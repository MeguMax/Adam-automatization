export function testPdfFixture(text = 'Test filing document'): Buffer {
    const escaped = text.replace(/[\\()]/g, '\\$&');
    const stream = `BT /F1 12 Tf 40 740 Td (${escaped}) Tj ET`;
    const objects = [
        '<< /Type /Catalog /Pages 2 0 R >>',
        '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
        '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
        '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
        `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`,
    ];
    let content = '%PDF-1.4\n';
    const offsets = [0];
    objects.forEach((object, index) => {
        offsets.push(Buffer.byteLength(content));
        content += `${index + 1} 0 obj\n${object}\nendobj\n`;
    });
    const xref = Buffer.byteLength(content);
    content += `xref\n0 ${offsets.length}\n0000000000 65535 f \n`;
    for (const offset of offsets.slice(1)) content += `${String(offset).padStart(10, '0')} 00000 n \n`;
    content += `trailer\n<< /Size ${offsets.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
    return Buffer.from(content);
}

export function testComplaintFormFixture(): Buffer {
    const values: Record<number, string> = { 1:'25th',5:'Example Property LLC',
        6:'Alex Attorney P70000\r100 Legal Avenue\rLincoln Park, MI 48146\r248 555 0199',
        7:'Morgan Tenant, and all other occupants\r200 Rental Avenue\rLincoln Park, MI 48146',
        8:'On',9:'Off',32:'On',37:'1991.5' };
    const fields = Object.entries(values);
    const refs = fields.map((_,index)=>`${index+7} 0 R`).join(' ');
    const stream = 'BT /F1 10 Tf 40 740 Td (DC 102a COMPLAINT, NONPAYMENT OF RENT) Tj 0 -14 Td (SUPPLEMENTAL COMPLAINT) Tj ET';
    const objects = [
        '<< /Type /Catalog /Pages 2 0 R /AcroForm 6 0 R >>',
        '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
        `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Annots [${refs}] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>`,
        '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
        `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
        `<< /Fields [${refs}] /DA (/F1 10 Tf 0 g) /DR << /Font << /F1 4 0 R >> >> >>`,
        ...fields.map(([key,value])=> {
            const checkbox = [8,9,32].includes(Number(key));
            const escaped = value.replace(/[\\()]/g, '\\$&').replace(/\r/g,'\\r');
            return `<< /Type /Annot /Subtype /Widget /P 3 0 R /Rect [40 500 280 560] /T (dc102a_${key.padStart(2,'0')}) /FT /${checkbox?'Btn':'Tx'} /V ${checkbox?'/'+value:'('+escaped+')'} >>`;
        }),
    ];
    let content = '%PDF-1.4\n'; const offsets=[0];
    objects.forEach((object,index)=>{offsets.push(Buffer.byteLength(content));content+=`${index+1} 0 obj\n${object}\nendobj\n`;});
    const xref=Buffer.byteLength(content);
    content+=`xref\n0 ${offsets.length}\n0000000000 65535 f \n`+offsets.slice(1).map(offset=>`${String(offset).padStart(10,'0')} 00000 n \n`).join('')+`trailer\n<< /Size ${offsets.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
    return Buffer.from(content);
}
