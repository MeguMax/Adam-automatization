import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createCanvas } from '@napi-rs/canvas';
import { recognizeScannedPdf, mergeOcrRegionWords, mergeOcrLineReads, type OcrLine } from './pdfOcr';
import { parseScannedComplaint } from './complaintExtractor';
import { inspectFilingPdf } from './pdfValidation';
import { isProcessingReportSubject } from './processingReport';
import { districtCode, planFormImport, planFormImports, resolveCourt } from './courtForms';
import { WorkflowDatabase } from './database';
import { buildFilingIntake } from './filingIntake';
import { recognizeDocumentText } from './documentRecognition';

test('Advice prose mentioning summons is not a second document title', () => {
    const advice = recognizeDocumentText(['Advice of Rights and Information (Landlord-Tenant)\nYou can file a motion before the date listed on the\nsummons, or ask the court in person at the first court hearing.'], '');
    assert.equal(advice.role, 'advice');
    assert.equal(advice.source, 'content');
    assert.equal(recognizeDocumentText(['Summons, Landlord-Tenant/Land Contract'], '').role, 'summons');
    assert.equal(recognizeDocumentText(['Advice of Rights and Information (Landlord-Tenant)', 'Summons, Landlord-Tenant/Land Contract'], '').source, 'conflict');
});

test('scanned Complaint footers identify the form without promoting prose references to titles',()=>{
    const scan='Original - Court\nih JUDICIAL DISTRICT COMPLAINT\n29th NONPAYMENT OF RENT\n'+
        Array(30).fill('Body text').join('\n')+'\nDC 102a (11/23) COMPLAINT, NONPAYMENT OF RENT, Landlord-Tenant';
    assert.equal(recognizeDocumentText([scan],'scan001.pdf').source,'content');
    assert.equal(recognizeDocumentText([scan],'scan001.pdf').role,'complaint');
    assert.equal(recognizeDocumentText(['Advice of Rights and Information (Landlord-Tenant)\nAttach form DC 102a Complaint if applicable'],'Advice.pdf').role,'advice');
});

test('actual Request title, DC102c layout, and letterhead Demand titles are recognized without filenames', () => {
    assert.equal(recognizeDocumentText(['REQUEST FOR COURT MAILING AND\nRECORD OF MAILING BY COURT\n(Landlord-Tenant)'], '').source, 'content');
    assert.equal(recognizeDocumentText(['JUDICIAL DISTRICT COMPLAINT TO\nRECOVER POSSESSION OF PROPERTY'], '').role, 'complaint');
    assert.equal(recognizeDocumentText(['STATE OF MICHIGAN DEMAND FOR POSSESSION\nNONPAYMENT OF RENT'], '').role, 'ancillary');
    const complaint=recognizeDocumentText(['COMPLAINT\nNONPAYMENT OF RENT\nAttached to this complaint is a copy of the demand for possession'], '');
    assert.equal(complaint.role,'complaint');
    assert.equal(complaint.source,'content');
});

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
    const original=pages[0].words[0].text;
    pages[0].words[0].text='Modified by caller';
    const cached=await recognizeScannedPdf(pdf,[1]);
    assert.equal(cached[0].words[0].text,original,'Cached page selections must be defensive copies');
    await assert.rejects(recognizeScannedPdf(pdf,[2]),/outside/);
});

test('OCR page selection rejects malformed requests before spawning a worker', async () => {
    for (const pages of [[],[0],[1,1],[1.5]]) await assert.rejects(recognizeScannedPdf(scannedFixture(),pages), /positive integers/);
});

test('OCR handles the two-column caption when The plaintiff states is on the right and flags low-confidence names', () => {
    const items = [
        ['Plaintiff name, address',40,110,95], ['Example Property LLC',40,135,95],
        ["Plaintiff's attorney, bar no.",40,205,95],
        ['Defendant name, address',326,110,95], ['Morgan Tenant',326,135,55],
        ['200 Rental Avenue',326,155,95], ['Lincoln Park, MI 48146',326,175,95],
        ['The plaintiff states:',326,205,95], ['25th District Court',40,70,95],
    ].map(([text,x,y,confidence])=>({text:String(text),x:Number(x),y:Number(y),confidence:Number(confidence),width:180,height:10,pageNumber:1}));
    const result=parseScannedComplaint([{text:'COMPLAINT, NONPAYMENT OF RENT\nSUPPLEMENTAL COMPLAINT\n'+items.map(i=>i.text).join('\n'),confidence:95,lines:items,words:items}]);
    assert.equal(result.data.defendants?.[0].postalCode,'48146');
    assert.equal(result.fieldConfidence.defendants,'low');
    assert.equal(result.data.moneyJudgmentRequested,undefined);
    assert.ok(result.warnings.some(w=>w.code==='scan_review'));
});

test('a caption boundary split across columns still finds wrapped business and person Defendants',()=>{
    const items=[['29th',48,80,59],['Plaintiff name, address',40,130,95],['Example Property LLC',40,146,95],
        ["Plaintiff's attorney, bar no.",40,202,95],['Defendant name, address',326,130,95],
        ['Example Ventures LLC, Morgan Tenant, and',326,146,95],['all other occupants',326,160,95],
        ['200 Rental Avenue',326,175,95],['Wayne, MI 48184',326,189,95],
        ['The',291,215,95],['plaintiff states:',326,215,95]]
        .map(([text,x,y,confidence])=>({text:String(text),x:Number(x),y:Number(y),confidence:Number(confidence),width:140,height:9,pageNumber:1}));
    const result=parseScannedComplaint([{text:'COMPLAINT, NONPAYMENT OF RENT\nSUPPLEMENTAL COMPLAINT\n'+items.map(i=>i.text).join('\n'),confidence:95,lines:items,words:items}]);
    assert.equal(result.data.courtDistrict,'29');
    assert.equal(result.fieldConfidence.courtDistrict,'low');
    assert.deepEqual(result.data.defendants?.map(p=>[p.displayName,p.partyType]),[['Example Ventures LLC','entity'],['Morgan Tenant','person']]);
    assert.equal(result.data.defendants?.[0].postalCode,'48184');
    assert.ok(result.warnings.some(w=>w.code==='scan_review'));
});

test('caption rereads never duplicate a clipped name or promote disagreeing spelling to confidence', () => {
    const word = (text:string,x:number,y:number,confidence:number):OcrLine =>
        ({text,x,y,width:25,height:8,confidence,pageNumber:1});
    const original = [word('Caption',40,130,95), word('Example',40,150,92), word('LLC',75,150,95), word('Outside',320,150,95)];
    const result = mergeOcrRegionWords(original,
        [word('Caption',40,130,96),word('Examp1e',40,150,96),word('LLC',75,150,96),word('100',40,170,95)],
        {left:39,top:149,right:289,bottom:190});
    assert.equal(result.filter(item => item.x===40 && item.y===150).length,1);
    assert.equal(result.find(item => item.y===150 && item.x===40)?.text,'Example');
    assert.ok(result.find(item => item.y===150 && item.x===40)!.confidence<80);
    assert.equal(result.filter(item => item.text==='Caption').length,1);
    assert.equal(result.find(item=>item.text==='LLC')?.confidence,96);
    assert.ok(result.some(item=>item.text==='100'));
    assert.ok(result.some(item=>item.text==='Outside'));
});

test('line consensus repairs uncertain spellings without treating a single read or a tie as agreement',()=>{
    const w=(text:string,confidence:number,x=40,y=150):OcrLine=>({text,confidence,x,y,width:35,height:8,pageNumber:1});
    const region={left:39,top:149,right:100,bottom:160};
    const original=[w('Raguel',89),w('Surname',95,110)];
    const result=mergeOcrLineReads(original,[[w('Raguel',90)],[w('Raquel',60)],[w('Raquel',15)]],region);
    assert.equal(result[0].text,'Raquel');assert.ok(result[0].confidence<80);assert.equal(result[1].text,'Surname');
    assert.equal(mergeOcrLineReads(original,[[w('Raquel',96)]],region)[0].text,'Raguel');
    assert.equal(mergeOcrLineReads(original,[[w('Raquel',96)],[w('Raguel',96)]],region)[0].text,'Raguel');
    const repeated=[w('MALIK',83),w('MALIK',81,40,350)];
    assert.equal(mergeOcrLineReads(repeated,[[w('MALTK',94)],[w('MALTK',93)],[w('MALIK',80)]],region)[0].text,'MALIK');
});

test('tight typewritten captions keep contact lines out of names and the right-column heading out of the attorney', () => {
    const word = (text:string,x:number,y:number,width=100):OcrLine =>
        ({text,x,y,width,height:7,confidence:95,pageNumber:1});
    const words=[word('Plaintiff name(s), address(es)',40,141,170),word('Example Estates LLC',40,150,180),
        word('248-555-0199',40,163),word('c/o Alex Attorney (P70000)',40,174,200),
        word('Plaintiff attorney, bar no.',40,194,210),word('Alex Attorney (P70000)',40,207,200),
        word('200 Legal Avenue',40,217,160),word('Example City, MI 480014551',40,227,210),word('248-555-0101',40,238),
        word('Defendant name(s) and address',310,141,210),word('Morgan Tenant, and all other occupants',310,153,265),
        word('[20251 Rental Avenue',310,164,180),word('Example City, MI 48002',310,174,210),
        word('The',298,206,18),word('plaintiff states:',319,206,80),word('There is no other pending',65,272,220),
        word('25th District Court',40,75,160)];
    const result=parseScannedComplaint([{text:'COMPLAINT, NONPAYMENT OF RENT\nSUPPLEMENTAL COMPLAINT\n'+words.map(w=>w.text).join('\n'),
        confidence:90,words,lines:words,selections:{money:false,noRelated:true,previousRelated:false}}]);
    assert.equal(result.data.plaintiff?.displayName,'Example Estates LLC');
    assert.equal(result.data.attorney?.displayName,'Alex Attorney');
    assert.equal(result.data.attorney?.address1,'200 Legal Avenue');
    assert.equal(result.data.attorney?.postalCode,'48001-4551');
    assert.equal(result.data.defendants?.[0].address1,'20251 Rental Avenue');
    assert.deepEqual(result.data.defendants?.map(p=>p.displayName),['Morgan Tenant']);
    assert.equal(result.data.includeAllOtherOccupants,true);
    assert.equal(result.data.moneyJudgmentRequested,false);
    assert.equal(result.data.claimAmount,'0.00');
});

test('caption column boundaries exclude a paragraph number aligned with the attorney street address', () => {
    const word=(text:string,x:number,y:number,width=150,confidence=95):OcrLine=>({text,x,y,width,height:8,confidence,pageNumber:1});
    const words=[word('Plaintiff name(s), address(es)',40,140,180),word('Example Owner LLC',40,153,180),
        word('Plaintiff attorney, bar no.',40,201,200),word('Alex Attorney P70000',40,214,160),
        word('200 Legal Avenue',40,225,140),word('Example City, MI 48001',40,236,180),word('248-555-0101',40,247,100),
        word('Defendant name(s) and address',310,140,200),word('Morgan Tenant, and all other occupants',310,153,260),
        word('300 Rental Street',310,165,160),word('v',296,165,7),word('Example City, MI 48002',310,177,180),
        word('The plaintiff states:',295,205,100),word('1.',296,224,7),word('Attached to this complaint',307,224,190),
        word('There is no other pending',65,272,200),word('25th District Court',40,75,150,65)];
    const result=parseScannedComplaint([{text:'COMPLAINT, NONPAYMENT OF RENT\nSUPPLEMENTAL COMPLAINT\n'+words.map(w=>w.text).join('\n'),
        confidence:90,words,lines:words,selections:{money:false,noRelated:true,previousRelated:false}}]);
    assert.equal(result.data.attorney?.address1,'200 Legal Avenue');
    assert.equal(result.data.attorney?.phone,'248-555-0101');
    assert.equal(result.data.defendants?.[0].address1,'300 Rental Street');
    assert.ok(result.warnings.some(warning=>warning.code==='caption_review'&&warning.field==='courtDistrict'));
});

test('a later scanned page cannot overwrite a contradictory paragraph answer', () => {
    const page={text:'COMPLAINT, NONPAYMENT OF RENT\nSUPPLEMENTAL COMPLAINT',confidence:95,words:[],lines:[]};
    const result=parseScannedComplaint([{...page,selections:{money:true,noRelated:true,previousRelated:false}},
        {...page,selections:{money:false,noRelated:false,previousRelated:true}}]);
    assert.equal(result.data.moneyJudgmentRequested,undefined);
    assert.equal(result.data.relatedCivilAction,undefined);
    assert.equal(result.data.claimAmount,undefined);
    assert.ok(result.warnings.some(w=>w.code==='source_conflict'&&w.field==='relatedCivilAction'));
});

test('processing report correspondence cannot be mistaken for source filings', () => {
    for (const subject of ['ERROR processing MiFILE/TrueFiling email: 26-1', 'RE: FW: MiFILE/TrueFiling processed: NO CASE', 'MiFILE/TrueFiling retry completed: 26-1']) assert.equal(isProcessingReportSubject(subject), true);
    assert.equal(isProcessingReportSubject('MiFILE - Document Sent 26-1'), false);
    assert.equal(isProcessingReportSubject('NEW LT FILING - Example'), false);
});

test('court matching requires a unique observed court and plans approved special packets', () => {
    const court = 'MI Wayne County - Lincoln Park - 25th District Court';
    const court21 = 'MI Wayne County - Garden City - 21st District Court';
    const court73 = 'MI Sanilac County - Sandusky - 73A District Court';
    assert.equal(districtCode(court), '25');
    assert.equal(districtCode('MI Example - 52nd District Court - 1st Division'), '52-1');
    assert.equal(resolveCourt('25', [court]), court);
    assert.equal(resolveCourt('25', [court, 'MI Another - 25th District Court']), null);
    assert.equal(planFormImport('25 Local.pdf', [court]).courtName, court);
    assert.deepEqual(planFormImport('21 Local Zoom.pdf', [court21]), {
        role:'local', courtName:court21, slotKey:'zoom-instructions', allowMixedTitles:false,
    });
    assert.deepEqual(planFormImport('73A Local.pdf', [court73]), {
        role:'local', courtName:court73, slotKey:'primary', allowMixedTitles:true,
    });
    assert.equal(planFormImport('21 Local Zoom.pdf', []).courtName, court21);
    assert.equal(planFormImport('41A1 Local.pdf', []).courtName,
        'MI Macomb County - Sterling Heights - 41A-1 District Court');
    assert.deepEqual(planFormImports('72 Local.pdf', []).map(plan => plan.courtName), [
        'MI Saint Clair County - Marine City - 72-1 District Court',
        'MI Saint Clair County - Port Huron - 72-2 District Court',
    ]);
    assert.throws(() => planFormImport('72 Local.pdf', []), /2 MiFILE courts/);
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
