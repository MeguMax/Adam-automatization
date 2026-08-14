import assert from 'node:assert/strict';
import test from 'node:test';
import {
    isComplaintDocument,
    parseComplaintText,
} from './complaintExtractor';

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
