// Offline verification only: source PDFs stay local and all cloud writes are mocked.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');
const { parseArgs } = require('node:util');

const { values } = parseArgs({ options: {
    packages: {type:'string'}, forms:{type:'string'}, scan:{type:'string'}, mixed:{type:'string'}, output:{type:'string'},
}});
for (const key of ['packages','forms','scan','mixed','output']) if (!values[key]) throw new Error('Missing --'+key);
const temporary = fs.mkdtempSync(path.join(os.tmpdir(),'client-intake-offline-'));
Object.assign(process.env,{TENANT_ID:'11111111-1111-1111-1111-111111111111',CLIENT_ID:'offline',CLIENT_SECRET:'offline',
    USER_EMAIL:'qa@example.com',ONEDRIVE_ROOT_SHARE_URL:'https://onedrive.example/root',WORKFLOW_DB_PATH:path.join(temporary,'workflow.sqlite')});
let networkAttempts=0;
globalThis.fetch=async()=>{networkAttempts++;throw new Error('Network is prohibited in this offline verification');};
const drive=require('../dist/oneDriveClient');
drive.ensureIntakeFolder=async()=>({driveId:'offline',itemId:'offline'});
drive.uploadFileBufferToFolder=async(_drive,_folder,fileName)=>({driveId:'offline',itemId:fileName,fileName});
drive.createFileLink=async(_drive,name)=>'https://onedrive.example/'+encodeURIComponent(name);
const {WorkflowDatabase}=require('../dist/database');
const {buildFilingIntake}=require('../dist/filingIntake');
const {processFilingIntake}=require('../dist/filingIntakeWorker');
const {extractComplaintPdf,CURRENT_COMPLAINT_EXTRACTOR_VERSION}=require('../dist/complaintExtractor');
const {ensureDraftComplaintExtraction}=require('../dist/draftExtraction');
const {saveFormPdf}=require('../dist/formLibrary');
const {planFormImport}=require('../dist/courtForms');

async function main(){
    const db=new WorkflowDatabase(process.env.WORKFLOW_DB_PATH);
    const results=[];
    try {
        for(const name of ['- Advice.pdf','29 Local.pdf','37 Local.pdf','42-2 Local.pdf','45 Local.pdf'])
            await saveFormPdf(db,{...planFormImport(name,[]),filename:name,content:fs.readFileSync(path.join(values.forms,name))});
        const cases=fs.readdirSync(values.packages,{withFileTypes:true}).filter(entry=>entry.isDirectory()).map(entry=>({
            name:entry.name, files:fs.readdirSync(path.join(values.packages,entry.name)).filter(name=>/\.pdf$/i.test(name))
                .map(name=>({name,path:path.join(values.packages,entry.name,name)})),
        }));
        const base=cases.find(item=>item.files.some(file=>/warady.*complaint/i.test(file.name)));
        if(!base) throw new Error('A Warady source package is required for the two additional offline fixtures');
        for(const [name,complaint] of [['Warady image-only OCR',values.scan],['Mixed company and people',values.mixed]])
            cases.push({name,files:[...base.files.filter(file=>!/complaint/i.test(file.name)),{name:'Complaint.pdf',path:complaint}]});
        for(const sample of cases){
            const message={id:'offline:'+sample.name,subject:'NEW LT FILING - '+sample.name,from:{emailAddress:{address:'qa@example.com'}}};
            const parsed=buildFilingIntake(message,sample.files.map((file,index)=>({id:String(index),name:file.name,contentType:'application/pdf',size:fs.statSync(file.path).size})));
            const email=db.registerEmail(message);
            const id=db.createCaseDraft(email.id,parsed);
            let detail=await processFilingIntake(db,email.id,id,parsed,{extract:extractComplaintPdf,download:async request=>{
                const source=request.filedDocuments[0];
                const file=sample.files.find(file=>file.name===source.documentName);
                if(!file) throw new Error('Unknown source document');
                const buffer=fs.readFileSync(file.path);
                return {downloaded:[{documentType:source.documentType,documentName:file.name,localPath:file.name,downloadAttempts:1}],failures:[],
                    notificationFiles:[{displayName:file.name,fileName:file.name,buffer,driveId:'offline',itemId:file.name,webUrl:'https://onedrive.example/'+encodeURIComponent(file.name)}]};
            }});
            assert.equal(detail.caseDraft.complaintExtraction.extractorVersion,CURRENT_COMPLAINT_EXTRACTOR_VERSION);
            assert.ok(detail.caseDraft.filingData.plaintiff.address1);
            assert.ok(detail.caseDraft.filingData.defendants.length);
            const filing=structuredClone(detail.caseDraft.filingData);
            filing.plaintiff.phone='248-555-0101';
            db.updateCaseDraft(id,{},undefined,filing);
            const source=sample.files.find(file=>file.name===detail.documents.find(doc=>doc.isPrimary).originalFilename);
            await ensureDraftComplaintExtraction(db,id,{force:true,content:fs.readFileSync(source.path)});
            detail=db.getDraftDetail(id);
            assert.equal(detail.caseDraft.filingData.plaintiff.phone,'248-555-0101');
            if(sample.name==='Warady image-only OCR'){
                assert.equal(detail.caseDraft.filingData.defendants[0].displayName,'Ashlee Warady');
                assert.equal(detail.caseDraft.filingData.courtDistrict,'29');
                assert.equal(detail.caseDraft.filingData.claimAmount,'1991.50');
                assert.equal(detail.caseDraft.filingData.attorney.address1,'30850 Telegraph Rd Ste 250');
                assert.ok(detail.caseDraft.validationIssues.some(issue=>/scan/i.test(issue.message)));
            }
            if(sample.name==='Mixed company and people'){
                assert.deepEqual(detail.caseDraft.filingData.defendants.map(p=>p.partyType),['entity','person','person']);
                assert.equal(detail.caseDraft.filingData.plaintiff.address1,'30850 Telegraph Rd Ste 250');
            }
            results.push({sample:sample.name,sourcePdfs:sample.files.length,totalPdfs:detail.documents.length,
                fields:detail.caseDraft.filingData,issues:detail.caseDraft.validationIssues,manualOverridePreserved:true});
            console.log(JSON.stringify({sample:sample.name,issues:detail.caseDraft.validationIssues.map(issue=>issue.field),manualOverridePreserved:true}));
        }
        assert.equal(db.listFilingJobs().length,0);
        assert.equal(networkAttempts,0);
        fs.mkdirSync(path.dirname(path.resolve(values.output)),{recursive:true});
        fs.writeFileSync(values.output,JSON.stringify({drafts:results.length,networkAttempts,filingJobs:0,results},null,2));
        console.log(JSON.stringify({passed:true,drafts:results.length,sourcePdfs:results.reduce((sum,item)=>sum+item.sourcePdfs,0),networkAttempts,filingJobs:0}));
    } finally {
        db.close();
        assert.equal(path.dirname(path.resolve(temporary)),path.resolve(os.tmpdir()));
        assert.ok(path.basename(temporary).startsWith('client-intake-offline-'));
        fs.rmSync(temporary,{recursive:true,force:true});
    }
}
main().catch(error=>{console.error(error);process.exitCode=1;});
