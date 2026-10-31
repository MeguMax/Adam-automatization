import assert from 'node:assert/strict';
import test from 'node:test';
import {
    isComplaintDocument,
    parseComplaintText,
    parseComplaintFormFields,
    extractComplaintPdf,
    ComplaintFormWidget,
    applyVisualComplaintSelections,
} from './complaintExtractor';
import { testComplaintFormFixture } from './testPdfFixture';
import { createCanvas } from '@napi-rs/canvas';
import { readCheckboxBeforeAnchor, mergeComplaintSelections, readComplaintSelections } from './pdfCheckboxes';
import { recognizeDocumentText } from './documentRecognition';

const POSSESSION_ONLY_TEXT = `
DC 102a (11/23) COMPLAINT, NONPAYMENT OF RENT, Landlord-Tenant
SUPPLEMENTAL COMPLAINT
J
K
25th
100 Court Street Example, MI 48000 313 555 0100
Example Property Management
Alex Attorney P70000
200 Legal Avenue
Example City, MI 48001
248 555 0199
Taylor Tenant, and all other occupants
300 Rental Street Apt 4
Example City, MI 48002
4
Example Property Management
300 Rental Street Apt 4 Example City, MI 48002
900 month 1st of the month
3/31/2026 975
4
5/20/2026 /s/ Alex Attorney
56.65 / 13.39
Tenant T Complaint
26-01000-LT
`;

test('recognizes Complaint documents without treating every filing as primary', () => {
    assert.equal(isComplaintDocument('Complaint for Possession Only', 'case.pdf'), true);
    assert.equal(isComplaintDocument('Summons, Landlord-Tenant', 'Summons.pdf'), false);
});

test('termination Complaints use the same LT fields without an unsupported-form blocker', () => {
    const result = parseComplaintText(POSSESSION_ONLY_TEXT.replace('NONPAYMENT OF RENT', 'TERMINATION OF TENANCY'));
    assert.equal(result.formType, 'TERMINATION OF TENANCY');
    assert.ok(!result.warnings.some(warning => warning.code === 'unsupported_form'));
    assert.equal(result.data.plaintiff?.entityName, 'Example Property Management');
});

test('extracts high-confidence filing fields from a Michigan Complaint', () => {
    const result = parseComplaintText(POSSESSION_ONLY_TEXT, {
        documentType: 'Complaint for Possession Only',
    });

    assert.equal(result.formType, 'NONPAYMENT OF RENT');
    assert.equal(result.data.courtDistrict, '25');
    assert.equal(result.data.caseNumber, '26-01000-LT');
    assert.equal(result.data.plaintiff?.entityName, 'Example Property Management');
    assert.equal(result.data.attorney?.displayName, 'Alex Attorney');
    assert.equal(result.data.attorney?.barNumber, 'P70000');
    assert.equal(result.data.attorney?.phone, '248-555-0199');
    assert.equal(result.data.defendants?.[0].firstName, 'Taylor');
    assert.equal(result.data.defendants?.[0].lastName, 'Tenant');
    assert.equal(result.data.defendants?.[0].address1, '300 Rental Street Apt 4');
    assert.equal(result.data.defendants?.[0].city, 'Example City');
    assert.equal(result.data.defendants?.[0].state, 'MI');
    assert.equal(result.data.defendants?.[0].postalCode, '48002');
    assert.equal(result.data.includeAllOtherOccupants, true);
    assert.equal(result.fieldConfidence.defendants, 'high');
    assert.ok(result.warnings.some(warning => warning.code === 'related_action_review'));
    assert.ok(!result.warnings.some(warning => warning.code === 'claim_amount_review'));
});

test('keeps ambiguous multiple Defendants together and requests review', () => {
    const result = parseComplaintText(
        POSSESSION_ONLY_TEXT.replace(
            'Taylor Tenant, and all other occupants',
            'Taylor Tenant and Jordan Resident, and all other occupants',
        ),
        { documentType: 'Complaint for Possession and Supplemental Money Judgment (Fee Varies)' },
    );

    assert.equal(
        result.data.defendants?.[0].displayName,
        'Taylor Tenant and Jordan Resident',
    );
    assert.equal(result.fieldConfidence.defendants, 'medium');
    assert.ok(result.warnings.some(warning => warning.code === 'multiple_defendants_review'));
    assert.ok(result.warnings.some(warning => warning.code === 'claim_amount_review'));
});

test('reads paragraph 2, paragraph 10, and the claim amount from positioned PDF values', () => {
    const result = parseComplaintText(POSSESSION_ONLY_TEXT, {
        documentType: 'Complaint for Possession and Supplemental Money Judgment (Fee Varies)',
        positionedValues: [
            { text: '4', x: 53.9, y: 518.8 },
            { text: '4', x: 41.9, y: 98.8 },
            { text: '1471.010000', x: 169.2, y: 63.0 },
        ],
    });

    assert.equal(result.extractorVersion, 2);
    assert.equal(result.data.relatedCivilAction, 'none');
    assert.equal(result.data.moneyJudgmentRequested, true);
    assert.equal(result.data.claimAmount, '1471.01');
    assert.equal(result.data.mailingRequested, true);
    assert.equal(result.fieldConfidence.relatedCivilAction, 'high');
    assert.equal(result.fieldConfidence.moneyJudgmentRequested, 'high');
    assert.ok(!result.warnings.some(warning => warning.code === 'related_action_review'));
    assert.ok(!result.warnings.some(warning => warning.code === 'claim_amount_review'));
});

function formWidgets(overrides: Record<number, string> = {}, prefix = 'dc102a'): ComplaintFormWidget[] {
    const values: Record<number, string> = {
        1: '42-2', 2: '', 5: 'Example Property, LLC',
        6: 'Alex Attorney P70000\r200 Legal Avenue\rExample City, MI 48001\r248 555 0199',
        7: 'Taylor Tenant, Jordan Resident, and all other occupants\r300 Rental Street Apt 4\rExample City, MI 48002',
        8: 'On', 9: 'Off', 32: 'On', 34: '900', 37: '1,991.50',
        ...overrides,
    };
    return Object.entries(values).map(([number, fieldValue]) => ({
        fieldName: `${prefix}_${number.padStart(2, '0')}`, fieldValue,
        fieldType: [8,9,32,39].includes(Number(number)) ? 'Btn' : 'Tx',
        checkBox: [8,9,32,39].includes(Number(number)),
    }));
}

const FORM_TITLE = 'DC 102a (11/23) COMPLAINT, NONPAYMENT OF RENT\nSUPPLEMENTAL COMPLAINT';

test('AcroForm values preserve spelling, multiline addresses, multiple Defendants, and exact claim amounts', () => {
    const result = parseComplaintFormFields(FORM_TITLE, formWidgets())!;
    assert.equal(result.extractionMethod, 'form_fields');
    assert.equal(result.textSource, 'pdf');
    assert.equal(result.data.courtDistrict, '42-2');
    assert.equal(result.data.plaintiff?.entityName, 'Example Property, LLC');
    assert.deepEqual(result.data.defendants?.map(p => p.displayName), ['Taylor Tenant','Jordan Resident']);
    assert.ok(result.data.defendants?.every(p => p.address1 === '300 Rental Street Apt 4' && p.postalCode === '48002'));
    assert.equal(result.data.includeAllOtherOccupants, true);
    assert.equal(result.data.relatedCivilAction, 'none');
    assert.equal(result.data.moneyJudgmentRequested, true);
    assert.equal(result.data.claimAmount, '1991.50');
    assert.equal(result.data.attorney?.barNumber, 'P70000');
    assert.equal(result.warnings.length, 0);
});

test('AcroForm missing values and ambiguous boxes do not default to possession only or use monthly rent as the claim', () => {
    const missing = parseComplaintFormFields(FORM_TITLE, formWidgets({8:'Off',9:'Off',37:''}))!;
    assert.equal(missing.data.relatedCivilAction, undefined);
    assert.equal(missing.data.claimAmount, undefined);
    assert.ok(missing.warnings.some(w=>w.code==='claim_amount_review'));
    assert.equal(parseComplaintFormFields(FORM_TITLE, formWidgets({32:''}))!.data.moneyJudgmentRequested, undefined);
    assert.equal(parseComplaintFormFields(FORM_TITLE, formWidgets({37:'1,99.50'}))!.data.claimAmount, undefined);
    const unchecked = parseComplaintFormFields(FORM_TITLE, formWidgets({32:'Off'}))!;
    assert.equal(unchecked.data.claimAmount, '0.00');
    assert.equal(unchecked.data.moneyJudgmentRequested, false);
    assert.equal(parseComplaintFormFields(FORM_TITLE, formWidgets({5:'',7:''})), null, 'empty overlay widgets must not override visible flattened text');
});

test('repeated PDF widgets agree by value but conflicting fields never use the last copy', () => {
    const duplicate = formWidgets();
    const same = parseComplaintFormFields(FORM_TITLE, [...duplicate, ...structuredClone(duplicate)])!;
    assert.equal(same.data.claimAmount, '1991.50');
    assert.deepEqual(same.warnings, []);
    const irrelevant = parseComplaintFormFields(FORM_TITLE,[...formWidgets({32:'Off',10:'Unused court A'}),
        {fieldName:'dc102a_37',fieldType:'Tx',fieldValue:'999.00'},
        {fieldName:'dc102a_10',fieldType:'Tx',fieldValue:'Unused court B'}])!;
    assert.equal(irrelevant.data.claimAmount,'0.00');
    assert.equal(irrelevant.data.relatedCivilAction,'none');
    assert.deepEqual(irrelevant.warnings,[],'unselected conditional fields must not create false conflicts');
    const exportValue = parseComplaintFormFields(FORM_TITLE,[...duplicate,
        {fieldName:'dc102a_32',fieldType:'Btn',checkBox:true,fieldValue:'Yes'}])!;
    assert.equal(exportValue.data.moneyJudgmentRequested,true);
    assert.deepEqual(exportValue.warnings,[],'equivalent checked exports must not conflict');
    for (const [number, value, field] of [[5,'Another Owner LLC','plaintiff'],[7,'Another Tenant','defendants'],
        [1,'25th','courtDistrict'],[32,'Off','moneyJudgmentRequested'],[37,'2500.00','claimAmount']] as const) {
        const item = formWidgets({[number]:value}).find(widget => widget.fieldName === 'dc102a_' + String(number).padStart(2,'0'))!;
        for (const widgets of [[...duplicate,item],[item,...duplicate]]) {
            const result = parseComplaintFormFields(FORM_TITLE, widgets)!;
            assert.equal(result.data[field], undefined, field);
            assert.ok(result.warnings.some(warning => warning.code === 'source_conflict' && warning.field === field), field);
        }
    }
});

test('checkbox observations preserve known answers across blank pages and quarantine contradictions', () => {
    assert.deepEqual(mergeComplaintSelections([{money:true,noRelated:true},{money:undefined},{previousRelated:false}]),
        {money:true,noRelated:true,previousRelated:false});
    const conflicted = mergeComplaintSelections([{money:true,noRelated:true},{money:false,noRelated:false},{money:true}]);
    assert.equal(conflicted.money, undefined);
    assert.equal(conflicted.noRelated, undefined);
    assert.deepEqual(conflicted.conflicts, ['money','noRelated']);
    assert.equal(mergeComplaintSelections([conflicted,{money:true}]).money, undefined);
    const source = parseComplaintText(POSSESSION_ONLY_TEXT);
    source.data.moneyJudgmentRequested = true; source.data.claimAmount = '900.00'; source.data.relatedCivilAction = 'none';
    const result = applyVisualComplaintSelections(source, conflicted, []);
    assert.equal(result.data.moneyJudgmentRequested, undefined);
    assert.equal(result.data.claimAmount, undefined);
    assert.equal(result.data.relatedCivilAction, undefined);
    assert.ok(result.warnings.some(w => w.code === 'source_conflict' && w.field === 'moneyJudgmentRequested'));
});

test('duplicate visual paragraph labels cannot silently select the first checkbox', () => {
    const canvas=createCanvas(1836,2376),context=canvas.getContext('2d');context.scale(3,3);
    context.fillStyle='#fff';context.fillRect(0,0,612,792);context.strokeStyle='#000';context.lineWidth=0.6;
    const anchors=[100,200].map(y=>({text:'10.',x:60,y,width:14,height:10}));
    for (const anchor of anchors) context.strokeRect(48,anchor.y,9,9);
    context.lineWidth=1.5;context.beginPath();context.moveTo(49,104);context.lineTo(52,107);context.lineTo(56,101);context.stroke();
    const result=readComplaintSelections(context.getImageData(0,0,canvas.width,canvas.height).data,canvas.width,canvas.height,anchors);
    assert.equal(result.money,undefined);assert.deepEqual(result.conflicts,['money']);
});

test('DC102c excludes the attorney-confirmed third-party notice block from the parties', () => {
    const result = parseComplaintFormFields('DC 102c COMPLAINT TO RECOVER POSSESSION OF PROPERTY\nSUPPLEMENTAL COMPLAINT',
        formWidgets({39:'Off',7:'Taylor Tenant, Jordan Resident, and all other occupants\r300 Rental Street\rExample City, MI 48002\rNotice per MCL 600.3238(6):\rExample Association'}, 'dc102c'))!;
    assert.equal(result.formType, 'RECOVER POSSESSION OF PROPERTY');
    assert.equal(result.data.moneyJudgmentRequested, false);
    assert.equal(result.data.claimAmount, '0.00');
    assert.equal(result.data.defendants?.length, 2);
    assert.ok(!result.warnings.some(w=>w.code==='caption_review'));
});

test('mixed companies and people become separate parties without splitting a company suffix or name', () => {
    const result = parseComplaintFormFields(FORM_TITLE,formWidgets({7:
        'Example Ventures, LLC, Morgan Tenant, Taylor Resident, and all other occupants; Third Party LLC\r300 Rental Street\rExample City, MI 48002'}))!;
    assert.deepEqual(result.data.defendants?.map(p=>[p.displayName,p.partyType]),[
        ['Example Ventures, LLC','entity'],['Morgan Tenant','person'],['Taylor Resident','person'],
    ]);
    assert.equal(result.data.defendants?.[0].entityName,'Example Ventures, LLC');
    assert.equal(result.data.defendants?.[1].lastName,'Tenant');
    assert.ok(result.data.defendants?.every(p=>p.address1==='300 Rental Street'));
    assert.ok(!result.warnings.some(w=>w.code==='multiple_defendants_review'));
    const company=parseComplaintFormFields(FORM_TITLE,formWidgets({7:'Smith and Jones LLC\r300 Rental Street\rExample City, MI 48002'}))!;
    assert.equal(company.data.defendants?.length,1);
    assert.equal(company.data.defendants?.[0].entityName,'Smith and Jones LLC');
    const joined=parseComplaintFormFields(FORM_TITLE,formWidgets({7:'Example Ventures LLC and Morgan Tenant\r300 Rental Street\rExample City, MI 48002'}))!;
    assert.deepEqual(joined.data.defendants?.map(p=>p.partyType),['entity','person']);
    const ambiguous=parseComplaintFormFields(FORM_TITLE,formWidgets({7:'Tenant, Morgan\r300 Rental Street\rExample City, MI 48002'}))!;
    assert.ok(ambiguous.warnings.some(w=>w.code==='multiple_defendants_review'));
});

test('unknown caption instructions still require review',()=>{
    const result=parseComplaintFormFields(FORM_TITLE,formWidgets({7:
        'Morgan Tenant\r300 Rental Street\rExample City, MI 48002\rUnexpected party instructions'}))!;
    assert.ok(result.warnings.some(w=>w.code==='caption_review'));
});

test('real interactive PDF extracts Widget values even when page text contains only the blank template', async () => {
    const result = await extractComplaintPdf(testComplaintFormFixture());
    assert.equal(result.extractionMethod, 'form_fields');
    assert.equal(result.data.plaintiff?.displayName, 'Example Property LLC');
    assert.equal(result.data.defendants?.[0].displayName, 'Morgan Tenant');
    assert.equal(result.data.defendants?.[0].postalCode, '48146');
    assert.equal(result.data.claimAmount, '1991.50');
    assert.equal(result.warnings.length, 0);
    assert.equal(recognizeDocumentText(['DC 102a COMPLAINT, NONPAYMENT OF RENT\nSUPPLEMENTAL COMPLAINT'], 'scan001.pdf').source,'content');
});

test('visual checkbox reading distinguishes a checked square, an empty square and absent geometry',()=>{
    const canvas=createCanvas(1836,2376);const context=canvas.getContext('2d');context.scale(3,3);
    context.fillStyle='#fff';context.fillRect(0,0,612,792);context.strokeStyle='#000';context.lineWidth=0.6;
    const anchor={text:'10.',x:60,y:100,width:14,height:10};
    const read=()=>readCheckboxBeforeAnchor(context.getImageData(0,0,canvas.width,canvas.height).data,canvas.width,canvas.height,anchor);
    assert.equal(read(),undefined);
    context.strokeRect(48,100,9,9);assert.equal(read(),false);
    context.lineWidth=1.5;context.beginPath();context.moveTo(49,104);context.lineTo(52,107);context.lineTo(56,101);context.stroke();
    assert.equal(read(),true);
});

test('paragraph 10 uses explicitly referenced total rent, never the monthly rent or unselected damages',()=>{
    const make=()=>parseComplaintText('COMPLAINT, NONPAYMENT OF RENT\nSUPPLEMENTAL COMPLAINT');
    const pages=[{text:'',confidence:100,lines:[],words:[
        {text:'d. Total rent due now is $',x:268,y:610,width:111,height:10,pageNumber:1,confidence:100},
        {text:'2,350.07',x:383,y:606,width:39,height:10,pageNumber:1,confidence:100},
        {text:'975.00',x:434,y:391,width:31,height:10,pageNumber:2,confidence:100},
    ]}];
    assert.equal(applyVisualComplaintSelections(make(),{money:true,rent:true,damages:false},pages).data.claimAmount,'2350.07');
    assert.equal(applyVisualComplaintSelections(make(),{money:true,rent:true,damages:true},pages).data.claimAmount,undefined);
    assert.equal(applyVisualComplaintSelections(make(),{money:false},pages).data.claimAmount,'0.00');
    assert.equal(applyVisualComplaintSelections(make(),{noRelated:false,previousRelated:false},pages).data.relatedCivilAction,undefined);
});

test('selected explicit damages are read from grouped OCR words, not the monthly rental rate',()=>{
    const make=()=>parseComplaintText('COMPLAINT, NONPAYMENT OF RENT\nSUPPLEMENTAL COMPLAINT');
    const words=[{text:'Damages',x:90,y:716,width:40,height:9,pageNumber:1,confidence:96},
        {text:'claimed:',x:133,y:716,width:34,height:8,pageNumber:1,confidence:95},
        {text:'1991.5',x:174,y:713,width:24,height:7,pageNumber:1,confidence:92}];
    const pages=[{text:'',confidence:95,lines:[],words}];
    assert.equal(applyVisualComplaintSelections(make(),{money:true,rent:true,damages:true},pages).data.claimAmount,'1991.50');
    assert.equal(applyVisualComplaintSelections(make(),{money:true,rent:true,damages:false},pages).data.claimAmount,undefined);
    const low=[{...pages[0],words:words.map(w=>({...w,confidence:75}))}];
    assert.equal(applyVisualComplaintSelections(make(),{money:true,damages:true},low).data.claimAmount,undefined);
    const conflict=[...pages,{...pages[0],words:words.map(w=>({...w,text:w.text==='1991.5'?'2500.00':w.text}))}];
    assert.equal(applyVisualComplaintSelections(make(),{money:true,damages:true},conflict).data.claimAmount,undefined);
    const combined=[{...pages[0],words:[{...words[0],text:'Damages claimed: 1991.50',width:140}]}];
    assert.equal(applyVisualComplaintSelections(make(),{money:true,damages:true},combined).data.claimAmount,'1991.50');
});

test('conflicting rent totals and damaged amount text cannot retain a previous automatic claim', () => {
    const make=()=>{const result=parseComplaintText(POSSESSION_ONLY_TEXT);result.data.claimAmount='999.00';return result;};
    const words=[{text:'d. Total rent due now is $',x:268,y:610,width:111,height:10,pageNumber:1,confidence:100},
        {text:'2350.07',x:383,y:606,width:39,height:10,pageNumber:1,confidence:100}];
    const first={text:'',confidence:100,lines:[],words};
    const other={...first,words:words.map(word=>({...word,pageNumber:2,text:word.text==='2350.07'?'2500.00':word.text}))};
    const result=applyVisualComplaintSelections(make(),{money:true,rent:true,damages:false},[first,other]);
    assert.equal(result.data.claimAmount,undefined);
    assert.ok(result.warnings.some(w=>w.code==='source_conflict'&&w.field==='claimAmount'));
    assert.equal(applyVisualComplaintSelections(make(),{money:true,damages:true},[]).data.claimAmount,undefined);
    assert.equal(applyVisualComplaintSelections(make(),{money:false,conflicts:['rent','damages']},[]).data.claimAmount,'0.00');
});
