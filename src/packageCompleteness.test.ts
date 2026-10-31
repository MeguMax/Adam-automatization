import assert from 'node:assert/strict';
import test from 'node:test';
import { completenessContext, evaluatePackageCompleteness, supportingEvidence, validCompletenessSnapshot, type CompletenessDocument } from './packageCompleteness';

const document=(id:string,kind='deed',source='content',hash='a'.repeat(64)):CompletenessDocument=>({id,oneDriveUrl:'https://onedrive.example/'+id,
    fileSize:100,sourceVersion:id+'-v1',packageRole:'ancillary',isPrimary:false,status:'uploaded',requiredForFiling:true,
    supportingEvidence:{kind,source,contentHash:hash} as any});

test('supplied supporting PDFs do not imply a separate Demand or Notice requirement for any LT variant',()=>{
    for(const kind of ['deed','lease','other','unknown']) {
        const docs=[document('other',kind)];
        const result=evaluatePackageCompleteness('Court',docs,'NONPAYMENT OF RENT');
        assert.equal(result.version,2);assert.equal(result.requirement,'supplied');assert.equal(result.source,'attorney_policy');
        assert.deepEqual(result.issues,[]);
        assert.deepEqual(evaluatePackageCompleteness('Court',docs,'RECOVER POSSESSION OF PROPERTY').issues,[]);
    }
    assert.deepEqual(evaluatePackageCompleteness('Court',[document('support','unknown','unknown')],null).issues,[]);
    assert.ok(evaluatePackageCompleteness('Court',[document('support','other','unknown','')],null).issues.length);
});

test('all supplied supporting documents remain separate snapshot members regardless of their semantic kinds',()=>{
    for(const kind of ['demand','notice_to_quit']) {
        const docs=[document('support',kind)];
        const result=evaluatePackageCompleteness('Court',docs,'RECOVER POSSESSION OF PROPERTY');
        assert.deepEqual(result.issues,[]);assert.equal(result.requirement,'supplied');assert.equal(result.source,'attorney_policy');
        assert.equal(validCompletenessSnapshot({courtName:'Court',documents:docs,completeness:result}),true);
    }
    const many=Array.from({length:5},(_,i)=>document('support-'+i,['deed','lease','affidavit','other','unknown'][i]));
    const result=evaluatePackageCompleteness('Court',many,null);
    assert.deepEqual(result.issues,[]);assert.equal(validCompletenessSnapshot({courtName:'Court',documents:many,completeness:result}),true);
    const docs=[document('demand','demand')];
    for(const changed of [{...docs[0],requiredForFiling:false},{...docs[0],status:'failed'},{...docs[0],oneDriveUrl:null}]) {
        assert.ok(evaluatePackageCompleteness('Court',[changed],'NONPAYMENT OF RENT').issues.length);
    }
});

test('legacy legal exceptions no longer gate preparation, but current hashes and source snapshots remain mandatory',()=>{
    const docs=[document('deed')],contextHash=completenessContext('Court',docs);
    const manual={requirement:'none',reason:'Attorney confirmed this package does not require a Demand or Notice.',contextHash};
    const result=evaluatePackageCompleteness('Court',docs,null,manual);
    assert.deepEqual(result.issues,[]);assert.equal(result.source,'attorney_policy');
    assert.equal(validCompletenessSnapshot({courtName:'Court',documents:docs,completeness:result}),true);
    const unhashed=[document('unread','other','unknown','')];
    assert.ok(evaluatePackageCompleteness('Court',unhashed,null,{...manual,contextHash:completenessContext('Court',unhashed)}).issues.length);
    assert.deepEqual(evaluatePackageCompleteness('Court',docs,null,{...manual,reason:'',contextHash:'old-review'}).issues,[]);
    for(const changed of [[{...docs[0],sourceVersion:'replacement'}],[...docs,document('added')],
        [{...docs[0],supportingEvidence:{...docs[0].supportingEvidence!,kind:'lease' as const}}],
        [{...docs[0],filingType:'Changed'}],[{...docs[0],filingRelation:'connected_to_complaint'}],
        [{...docs[0],packageRole:'complaint'}]]) {
        assert.equal(validCompletenessSnapshot({courtName:'Court',documents:changed,completeness:result}),false);
    }
    assert.equal(validCompletenessSnapshot({courtName:'Changed Court',documents:docs,completeness:result}),false);
    assert.equal(validCompletenessSnapshot({courtName:'Court',documents:docs}),false);
    assert.equal(validCompletenessSnapshot({courtName:'Court',documents:docs,completeness:{...result,version:1}}),false);
    assert.equal(validCompletenessSnapshot({courtName:'Court',documents:[],completeness:result}),false);
});

test('semantic confirmation is separate from Filing Type and bound to the actual PDF hash and source version',()=>{
    const recognition={role:'ancillary',source:'content',supportingKind:'deed',message:'Deed',contentHash:'a'.repeat(64)} as const;
    const reviewed={kind:'demand',sourceVersion:'v1',contentHash:recognition.contentHash};
    assert.equal(supportingEvidence(recognition,null,'v1').kind,'deed');
    assert.equal(supportingEvidence(recognition,reviewed,'v1').source,'manual');
    assert.equal(supportingEvidence({...recognition,contentHash:'b'.repeat(64)},reviewed,'v1').kind,'deed');
    assert.equal(supportingEvidence(recognition,reviewed,'v2').kind,'deed');
    assert.equal(supportingEvidence({...recognition,source:'filename'},null,'v1').source,'unknown');
});
