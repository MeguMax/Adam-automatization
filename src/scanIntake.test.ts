import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createCanvas } from '@napi-rs/canvas';
import { recognizeScannedPdf } from './pdfOcr';
import { parseScannedComplaint } from './complaintExtractor';
import { inspectFilingPdf } from './pdfValidation';
import { isProcessingReportSubject } from './processingReport';
import { districtCode, planFormImport, resolveCourt } from './courtForms';
import { WorkflowDatabase } from './database';
import { buildFilingIntake } from './filingIntake';

function scannedFixture(): Buffer {
    const canvas = createCanvas(1224, 1584);
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, 1224, 1584);
    ctx.fillStyle = '#000'; ctx.font = '24px Arial';
    const line = (text: string, x: number, y: number) => ctx.fillText(text, x * 2, y * 2);
    line('COMPLAINT, NONPAYMENT OF RENT', 40, 45);
    line('25th District Court', 40, 70);
    line("Plaintiff's name, address", 40, 110);
    line("Defendant's name, address", 320, 110);
    line('Example Property LLC', 40, 135);
    line('100 Main Street', 40, 155);
    line('Lincoln Park, MI 48146', 40, 175);
    line('Morgan Tenant', 320, 135);
    line('200 Rental Avenue', 320, 155);
    line('Lincoln Park, MI 48146', 320, 175);
    line("Plaintiff's attorney, bar no.", 40, 205);
    line('Alex Attorney P70000', 40, 230);
    line('The plaintiff states:', 40, 280);
    line('SUPPLEMENTAL COMPLAINT', 40, 610);
    line('10. Money judgment', 40, 650);
    const jpeg = canvas.toBuffer('image/jpeg');
    const stream = Buffer.from('q 612 0 0 792 0 0 cm /Im0 Do Q');
    const objects = [
        Buffer.from('<< /Type /Catalog /Pages 2 0 R >>'),
        Buffer.from('<< /Type /Pages /Kids [3 0 R] /Count 1 >>'),
        Buffer.from('<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /XObject << /Im0 4 0 R >> >> /Contents 5 0 R >>'),
        Buffer.concat([Buffer.from(`<< /Type /XObject /Subtype /Image /Width 1224 /Height 1584 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${jpeg.length} >>\nstream\n`), jpeg, Buffer.from('\nendstream')]),
        Buffer.concat([Buffer.from(`<< /Length ${stream.length} >>\nstream\n`), stream, Buffer.from('\nendstream')]),
    ];
    let result = Buffer.from('%PDF-1.4\n'); const offsets = [0];
    objects.forEach((object, index) => { offsets.push(result.length); result = Buffer.concat([result, Buffer.from(`${index+1} 0 obj\n`), object, Buffer.from('\nendobj\n')]); });
    const start = result.length;
    return Buffer.concat([result, Buffer.from(`xref\n0 ${offsets.length}\n0000000000 65535 f \n` + offsets.slice(1).map(offset => `${String(offset).padStart(10,'0')} 00000 n \n`).join('') + `trailer\n<< /Size ${offsets.length} /Root 1 0 R >>\nstartxref\n${start}\n%%EOF\n`)]);
}

test('real raster-only PDF is read offline; OCR parties become editable without guessing checkbox answers', async () => {
    const pdf = scannedFixture();
    assert.equal((await inspectFilingPdf(pdf))[0].trim(), '');
    const pages = await recognizeScannedPdf(pdf);
    assert.match(pages[0].text, /NONPAYMENT OF RENT/);
    const result = parseScannedComplaint(pages);
    assert.equal(result.data.plaintiff?.displayName, 'Example Property LLC');
    assert.equal(result.data.defendants?.[0].displayName, 'Morgan Tenant');
    assert.equal(result.data.defendants?.[0].postalCode, '48146');
    assert.equal(result.data.moneyJudgmentRequested, undefined);
    assert.equal(result.data.claimAmount, undefined);
    assert.equal(result.textSource, 'ocr');
    assert.ok(result.warnings.some(w => w.code === 'scan_review'));
});

test('processing report correspondence cannot be mistaken for source filings', () => {
    for (const subject of ['ERROR processing MiFILE/TrueFiling email: 26-1', 'RE: FW: MiFILE/TrueFiling processed: NO CASE', 'MiFILE/TrueFiling retry completed: 26-1']) assert.equal(isProcessingReportSubject(subject), true);
    assert.equal(isProcessingReportSubject('MiFILE - Document Sent 26-1'), false);
    assert.equal(isProcessingReportSubject('NEW LT FILING - Example'), false);
});

test('court matching requires a unique observed court and skips unresolved special packets', () => {
    const court = 'MI Wayne County - Lincoln Park - 25th District Court';
    assert.equal(districtCode(court), '25');
    assert.equal(districtCode('MI Example - 52nd District Court - 1st Division'), '52-1');
    assert.equal(resolveCourt('25', [court]), court);
    assert.equal(resolveCourt('25', [court, 'MI Another - 25th District Court']), null);
    assert.equal(planFormImport('25 Local.pdf', [court]).courtName, court);
    assert.throws(() => planFormImport('73A Local.pdf', []), /Awaiting/);
    assert.throws(() => planFormImport('21 Local Zoom.pdf', []), /Awaiting/);
});

test('migration stops phantom report retries without deleting source history or real failed downloads', () => {
    const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'report-repair-'));
    const file = path.join(folder, 'db.sqlite'); let db = new WorkflowDatabase(file);
    try {
        const msg = {id:'report',subject:'ERROR processing MiFILE/TrueFiling email: Case'};
        const email = db.registerEmail(msg);
        const parsed = buildFilingIntake(msg, []); delete parsed.sourceKind;
        const id = db.createCaseDraft(email.id, parsed);
        const documentId = db.addDocument({emailId:email.id,caseDraftId:id,sourceUrl:'email-attachment://Order',status:'failed',uploadSource:'test'});
        const real = db.registerEmail({id:'real',subject:'MiFILE - Document Sent Case'});
        db.markEmailFailed(real.id, 'Real download issue');
        db.close();
        const raw = new DatabaseSync(file); raw.prepare('DELETE FROM schema_migrations WHERE version = 23').run(); raw.close();
        db = new WorkflowDatabase(file);
        assert.equal(db.getEmailDetail(email.id)?.email.processingStatus, 'ignored');
        assert.equal(db.getEmailDetail(email.id)?.documents.find(d => d.id === documentId)?.status, 'not_downloadable');
        assert.equal(db.getEmailDetail(real.id)?.email.processingStatus, 'failed');
        assert.equal(db.listDrafts({source:'intake'}).totalItems, 0);
        assert.equal(db.listDrafts({source:'all'}).totalItems, 1);
    } finally { db.close(); fs.rmSync(folder,{recursive:true,force:true}); }
});
