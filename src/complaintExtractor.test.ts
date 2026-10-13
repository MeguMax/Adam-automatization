import assert from 'node:assert/strict';
import test from 'node:test';
import {
    isComplaintDocument,
    parseComplaintText,
    parseComplaintFormFields,
    extractComplaintPdf,
    ComplaintFormWidget,
} from './complaintExtractor';
import { testComplaintFormFixture } from './testPdfFixture';

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

test('DC102c recovery Complaint is supported and extra caption notice recipients still require review', () => {
    const result = parseComplaintFormFields('DC 102c COMPLAINT TO RECOVER POSSESSION OF PROPERTY\nSUPPLEMENTAL COMPLAINT',
        formWidgets({39:'Off',7:'Taylor Tenant, Jordan Resident, and all other occupants\r300 Rental Street\rExample City, MI 48002\rNotice per MCL 600.3238(6):\rExample Association'}, 'dc102c'))!;
    assert.equal(result.formType, 'RECOVER POSSESSION OF PROPERTY');
    assert.equal(result.data.moneyJudgmentRequested, false);
    assert.equal(result.data.claimAmount, '0.00');
    assert.equal(result.data.defendants?.length, 2);
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
});
