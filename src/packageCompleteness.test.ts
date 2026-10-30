import assert from 'node:assert/strict';
import test from 'node:test';
import { completenessContext, evaluatePackageCompleteness, supportingEvidence, validCompletenessSnapshot, type CompletenessDocument } from './packageCompleteness';

const document=(id:string,kind='deed',source='content',hash='a'.repeat(64)):CompletenessDocument=>({id,oneDriveUrl:'https://onedrive.example/'+id,
    fileSize:100,sourceVersion:id+'-v1',packageRole:'ancillary',isPrimary:false,status:'uploaded',requiredForFiling:true,
    supportingEvidence:{kind,source,contentHash:hash} as any});

test('a deed, lease, generic Other, filename and Complaint reference never stand in for a Demand',()=>{
    for(const kind of ['deed','lease','other','unknown']) {
        const docs=[document('other',kind)];
        const result=evaluatePackageCompleteness('Court',docs,'NONPAYMENT OF RENT');
        assert.equal(result.requirement,'demand');assert.match(result.issues[0].message,/missing a verified Demand/);
        assert.ok(evaluatePackageCompleteness('Court',docs,'RECOVER POSSESSION OF PROPERTY').issues.length);
    }
    for(const bad of [document('Demand.pdf','demand','unknown'),document('demand','demand','content','')]) {
        assert.ok(evaluatePackageCompleteness('Court',[bad],'NONPAYMENT OF RENT').issues.length);
    }
});

test('positive included ready content evidence resolves normal Demand and Notice packages automatically',()=>{
    for(const kind of ['demand','notice_to_quit']) {
        const docs=[document('support',kind)];
        const result=evaluatePackageCompleteness('Court',docs,'RECOVER POSSESSION OF PROPERTY');
        assert.deepEqual(result.issues,[]);assert.equal(result.requirement,kind);assert.equal(result.source,'documents');
        assert.equal(validCompletenessSnapshot({courtName:'Court',documents:docs,completeness:result}),true);
    }
    const docs=[document('demand','demand')];
    for(const changed of [{...docs[0],requiredForFiling:false},{...docs[0],status:'failed'},{...docs[0],oneDriveUrl:null}]) {
        assert.ok(evaluatePackageCompleteness('Court',[changed],'NONPAYMENT OF RENT').issues.length);
    }
});

test('explicit exceptions require an attorney reason and cannot outlive a source or court change',()=>{
    const docs=[document('deed')],contextHash=completenessContext('Court',docs);
    const manual={requirement:'none',reason:'Attorney confirmed this package does not require a Demand or Notice.',contextHash};
    const result=evaluatePackageCompleteness('Court',docs,null,manual);
    assert.deepEqual(result.issues,[]);assert.equal(result.source,'manual');
    assert.equal(validCompletenessSnapshot({courtName:'Court',documents:docs,completeness:result}),true);
    const unhashed=[document('unread','other','unknown','')];
    assert.ok(evaluatePackageCompleteness('Court',unhashed,null,{...manual,contextHash:completenessContext('Court',unhashed)}).issues.length);
    assert.ok(evaluatePackageCompleteness('Court',docs,null,{...manual,reason:''}).issues.length);
    for(const changed of [[{...docs[0],sourceVersion:'replacement'}],[...docs,document('added')],
        [{...docs[0],supportingEvidence:{...docs[0].supportingEvidence!,kind:'lease' as const}}]]) {
        assert.equal(evaluatePackageCompleteness('Court',changed,null,manual).reviewStale,true);
        assert.equal(validCompletenessSnapshot({courtName:'Court',documents:changed,completeness:result}),false);
    }
    assert.equal(evaluatePackageCompleteness('Changed Court',docs,null,manual).reviewStale,true);
    assert.equal(validCompletenessSnapshot({courtName:'Court',documents:docs}),false);
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
