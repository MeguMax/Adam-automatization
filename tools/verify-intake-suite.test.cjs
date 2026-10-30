const test = require('node:test');
const assert = require('node:assert/strict');
const { checkResult, validateManifest } = require('./verify-intake-suite.cjs');

const report = () => ({ networkAttempts: 0, filingJobs: 0, manualOverridePreserved: true, reprocessingIdempotent: true,
    pdfCount: 6, documents: [{ status: 'uploaded', recognition: { source: 'content', supportingKind: 'demand' } }],
    issues: [], extraction: { data: { moneyJudgmentRequested: false, claimAmount: '0.00' } }, fields: { defendants: [{ displayName: 'Example Tenant' }] } });

test('acceptance checks exact false, zero, nested fields and positive supporting evidence', () => {
    assert.equal(checkResult(report(), { review: false, pdfCount: 6, documentKinds: ['demand'],
        extraction: { moneyJudgmentRequested: false, claimAmount: '0.00' }, excludedDefendants: ['Notice recipient'] }), 2);
    for (const change of [{ networkAttempts: 1 }, { filingJobs: 1 }, { reprocessingIdempotent: false }, { manualOverridePreserved: false }])
        assert.throws(() => checkResult({ ...report(), ...change }, { review: false }));
    assert.throws(() => checkResult(report(), { extraction: { moneyJudgmentRequested: true } }));
    assert.throws(() => checkResult(report(), { documentKinds: ['deed'] }));
    assert.throws(() => checkResult(report(), { excludedDefendants: ['tenant'] }));
});

test('expected review must contain the required error rather than an unrelated warning', () => {
    const value = { ...report(), issues: [{ field: 'package.supporting', severity: 'error' }] };
    assert.doesNotThrow(() => checkResult(value, { review: true, errorFields: ['package.supporting'] }));
    assert.throws(() => checkResult(value, { review: false }));
    assert.throws(() => checkResult(value, { errorFields: ['package.request'] }));
    assert.throws(() => checkResult({ ...value, issues: [{ field: 'package.supporting', severity: 'warning' }] }, { errorFields: ['package.supporting'] }));
});

test('acceptance manifests require explicit outcomes and safe distinct output identities', () => {
    const value = { version: 1, cases: [{ id: 'sample-one', files: ['Complaint.pdf'], expected: { review: false } }] };
    assert.doesNotThrow(() => validateManifest(value));
    for (const invalid of [{ ...value, version: 2 }, { ...value, cases: [] }, { ...value, cases: [value.cases[0], value.cases[0]] },
        { ...value, cases: [{ ...value.cases[0], id: '../escape' }] }, { ...value, cases: [{ ...value.cases[0], expected: {} }] }])
        assert.throws(() => validateManifest(invalid));
});
