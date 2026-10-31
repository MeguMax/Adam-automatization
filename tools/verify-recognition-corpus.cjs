const fs=require('node:fs');
const path=require('node:path');
const os=require('node:os');
const assert=require('node:assert/strict');
const {spawnSync}=require('node:child_process');
const {parseArgs}=require('node:util');

function validateManifest(manifest) {
    assert.equal(manifest.version,1);
    assert.ok(Array.isArray(manifest.cases) && manifest.cases.length>0 && manifest.cases.length<=60);
    const ids=new Set();
    for(const sample of manifest.cases) {
        assert.match(sample.id,/^[a-z0-9][a-z0-9-]{0,69}$/);
        assert.ok(!ids.has(sample.id),'Duplicate corpus ID');ids.add(sample.id);
        assert.ok(typeof sample.file==='string' && /\.pdf$/i.test(sample.file));
        assert.ok(['complaint','summons','request','advice','local','ancillary','unknown'].includes(sample.expected?.role));
        if(sample.expected.extraction) assert.equal(sample.expected.role,'complaint');
    }
}

function checkResult(report,expected) {
    let compared=0;
    const issues=[];
    const compare=(actual,wanted,field)=>{
        if(Array.isArray(wanted)) {
            if(!Array.isArray(actual) || actual.length!==wanted.length) issues.push(field+': unexpected array length');
            wanted.forEach((value,index)=>compare(actual?.[index],value,field+'.'+index));
        } else if(wanted && typeof wanted==='object') {
            for(const [key,value] of Object.entries(wanted))compare(actual?.[key],value,field+'.'+key);
        } else {
            compared++;
            try {assert.deepEqual(actual,wanted,field);}catch{issues.push(field+': value differs from verified expectation');}
        }
    };
    compare(report.networkAttempts,0,'networkAttempts');
    compare(report.recognition?.role,expected.role,'role');
    if(expected.source)compare(report.recognition?.source,expected.source,'source');
    if(expected.pageCount!==undefined)compare(report.pageCount,expected.pageCount,'pageCount');
    if(expected.extraction)compare(report.extraction?.data,expected.extraction,'Complaint');
    for(const warning of expected.warnings || []) {
        compared++;
        if(!report.extraction?.warnings.some(item=>item.code===warning))issues.push('Missing required warning: '+warning);
    }
    return {passed:issues.length===0,compared,issues};
}

async function inspectFile(sample,root,output) {
    Object.assign(process.env,{TENANT_ID:'11111111-1111-1111-1111-111111111111',CLIENT_ID:'offline',CLIENT_SECRET:'offline',
        USER_EMAIL:'qa@example.com',ONEDRIVE_ROOT_SHARE_URL:'https://onedrive.example/root',
        WORKFLOW_DB_PATH:path.join(os.tmpdir(),'unused-recognition-'+process.pid+'.sqlite'),MIFILE_AUTO_PREPARE_ENABLED:'false'});
    let networkAttempts=0;
    globalThis.fetch=async()=>{networkAttempts++;throw new Error('External requests are prohibited during corpus recognition');};
    const {inspectFilingPdf}=require('../dist/pdfValidation');
    const {recognizeDocumentPages}=require('../dist/documentRecognition');
    const {extractComplaintPdf}=require('../dist/complaintExtractor');
    const file=path.resolve(root,sample.file),buffer=fs.readFileSync(file),pages=await inspectFilingPdf(buffer);
    const recognition=await recognizeDocumentPages(buffer,pages,'document.pdf');
    const namedRecognition=await recognizeDocumentPages(buffer,pages,sample.filename || path.basename(file));
    const extraction=recognition.role==='complaint' || sample.expected.role==='complaint' ? await extractComplaintPdf(buffer) : null;
    const report={id:sample.id,bytes:buffer.length,pageCount:pages.length,networkAttempts,
        recognition,namedRecognition,extraction,pages};
    fs.writeFileSync(output,JSON.stringify(report,null,2));
}

function runSuite(manifestFile,outputDirectory) {
    const manifest=JSON.parse(fs.readFileSync(manifestFile,'utf8'));validateManifest(manifest);
    const root=path.dirname(path.resolve(manifestFile)),output=path.resolve(outputDirectory),results=[];
    fs.mkdirSync(output,{recursive:true});
    for(const sample of manifest.cases) {
        const started=Date.now(),reportFile=path.join(output,sample.id+'.json');
        fs.rmSync(reportFile,{force:true});
        const child=spawnSync(process.execPath,[__filename,'--one',JSON.stringify(sample),'--root',root,'--output',reportFile],
            {timeout:480_000,windowsHide:true,encoding:'utf8',maxBuffer:2*1024*1024});
        fs.writeFileSync(path.join(output,sample.id+'.log'),(child.stdout || '')+(child.stderr || ''));
        try {
            assert.equal(child.error,undefined,child.error?.message);assert.equal(child.status,0,'Isolated recognition failed');
            const report=JSON.parse(fs.readFileSync(reportFile,'utf8')),checked=checkResult(report,sample.expected);
            results.push({id:sample.id,...checked,pageCount:report.pageCount,role:report.recognition.role,
                namedRole:report.namedRecognition.role,textSource:report.recognition.textSource,
                method:report.extraction?.extractionMethod || null,elapsedMs:Date.now()-started});
        } catch(error) {results.push({id:sample.id,passed:false,issues:[error.message],compared:0,elapsedMs:Date.now()-started});}
        console.log(JSON.stringify(results.at(-1)));
    }
    const summary={checkedAt:new Date().toISOString(),samples:results.length,passed:results.filter(row=>row.passed).length,
        comparedFields:results.reduce((sum,row)=>sum+row.compared,0),results};
    fs.writeFileSync(path.join(output,'summary.json'),JSON.stringify(summary,null,2));
    return summary;
}

module.exports={validateManifest,checkResult,runSuite};
if(require.main===module) {
    const {values}=parseArgs({options:{manifest:{type:'string'},output:{type:'string'},one:{type:'string'},root:{type:'string'}}});
    if(values.one) {
        inspectFile(JSON.parse(values.one),values.root,values.output).catch(error=>{console.error(error.message);process.exitCode=1;});
    } else {
        if(!values.manifest || !values.output)throw new Error('Use --manifest private-corpus.json --output private-results');
        const result=runSuite(values.manifest,values.output);
        if(result.passed!==result.samples)process.exitCode=1;
    }
}
