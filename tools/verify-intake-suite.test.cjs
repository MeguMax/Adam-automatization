const test = require('node:test');
const assert = require('node:assert/strict');
const { checkResult, validateManifest, singleCaseFixture } = require('./verify-intake-suite.cjs');

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

test('single-case checks refuse automatic merging of multiple intake groups', () => {
    const parsed={intake:{storageKey:'qa',issues:[],groups:[{key:'one'},{key:'two'}]},filedDocuments:[{documentName:'Complaint.pdf'}]};
    assert.throws(()=>singleCaseFixture(parsed),/multiple case groups/);
    assert.equal(parsed.intake.groups.length,2);
    const single={...parsed,intake:{storageKey:'qa',issues:[]}};
    assert.equal(singleCaseFixture(single),single);
});

test('curated historical packages are explicit manual fixtures and preserve their source documents and issues', () => {
    const parsed={intake:{storageKey:'qa',issues:['Original source issue'],groups:[{key:'one'},{key:'unassigned'}]},
        filedDocuments:[{documentName:'Complaint.pdf'},{documentName:'Unnamed supporting.pdf'}]};
    const curated=singleCaseFixture(parsed,true);
    assert.equal(curated.intake.manual,true);
    assert.equal(curated.intake.groups,undefined);
    assert.equal(curated.filedDocuments,parsed.filedDocuments);
    assert.equal(curated.intake.issues,parsed.intake.issues);
    assert.equal(parsed.intake.groups.length,2);
    assert.equal(parsed.intake.manual,undefined);
});

test('fixture manifests accept only explicitly named assembly modes', () => {
    const sample={id:'curated',files:['Complaint.pdf'],expected:{review:false}};
    for(const mode of ['automatic','curated_single_case'])assert.doesNotThrow(()=>validateManifest({version:1,cases:[{...sample,mode}]}));
    for(const mode of ['merge_all',true,null])assert.throws(()=>validateManifest({version:1,cases:[{...sample,mode}]}));
});
