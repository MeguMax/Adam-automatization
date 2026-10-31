const test=require('node:test');
const assert=require('node:assert/strict');
const {checkResult,validateManifest}=require('./verify-recognition-corpus.cjs');

test('recognition corpus checks unknown roles, exact zero/false and all Defendant entries',()=>{
    const report={networkAttempts:0,pageCount:1,recognition:{role:'complaint',source:'content'},
        extraction:{data:{moneyJudgmentRequested:false,claimAmount:'0.00',defendants:[{displayName:'Example Tenant'}]},warnings:[]}};
    const expected={role:'complaint',source:'content',pageCount:1,extraction:{moneyJudgmentRequested:false,claimAmount:'0.00',
        defendants:[{displayName:'Example Tenant'}]}};
    assert.equal(checkResult(report,expected).passed,true);
    assert.equal(checkResult({...report,networkAttempts:1},expected).passed,false);
    assert.equal(checkResult({...report,extraction:{...report.extraction,data:{...report.extraction.data,
        defendants:[...report.extraction.data.defendants,{displayName:'Unexpected party'}]}}},expected).passed,false);
    assert.equal(checkResult({...report,recognition:{role:'unknown'}},{role:'unknown'}).passed,true);
    assert.equal(checkResult(report,{...expected,warnings:['scan_review']}).passed,false);
});

test('corpus manifests require explicit roles and safe unique output identities',()=>{
    const sample={id:'case-one',file:'local.pdf',expected:{role:'complaint'}};
    assert.doesNotThrow(()=>validateManifest({version:1,cases:[sample]}));
    for(const cases of [[],[sample,sample],[{...sample,id:'../escape'}],[{...sample,expected:{}}],
        [{...sample,expected:{role:'unknown',extraction:{claimAmount:'0.00'}}}]]) {
        assert.throws(()=>validateManifest({version:1,cases}));
    }
});
