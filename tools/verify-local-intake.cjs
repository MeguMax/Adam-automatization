// Run the production intake pipeline offline; no mailbox, OneDrive or MiFILE writes.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const {parseArgs} = require('node:util');

const {values, positionals} = parseArgs({allowPositionals:true, options:{
    forms:{type:'string'}, output:{type:'string'}, 'expect-review':{type:'boolean',default:false},
}});
if (!positionals.length || !values.output) throw new Error('Use --output report.json [--forms directory] file.pdf ...');
const temporary = fs.mkdtempSync(path.join(os.tmpdir(),'local-intake-qa-'));
Object.assign(process.env,{TENANT_ID:'11111111-1111-1111-1111-111111111111',CLIENT_ID:'offline',CLIENT_SECRET:'offline',
    USER_EMAIL:'qa@example.com',ONEDRIVE_ROOT_SHARE_URL:'https://onedrive.example/root',WORKFLOW_DB_PATH:path.join(temporary,'workflow.sqlite')});
let networkAttempts=0;
globalThis.fetch=async()=>{networkAttempts++;throw new Error('Network is prohibited during offline intake verification');};
const {WorkflowDatabase}=require('../dist/database');
const {buildFilingIntake}=require('../dist/filingIntake');
const {downloadIntakeDocuments}=require('../dist/filingIntakeDownload');
const {processFilingIntake}=require('../dist/filingIntakeWorker');
const {emailAttachmentSourceName}=require('../dist/emailAttachmentSource');
const {extractComplaintPdf}=require('../dist/complaintExtractor');
const {ensureDraftComplaintExtraction}=require('../dist/draftExtraction');
const {saveFormPdf}=require('../dist/formLibrary');
const {planFormImports}=require('../dist/courtForms');

(async()=>{
    const db=new WorkflowDatabase(process.env.WORKFLOW_DB_PATH);
    try {
        if(values.forms) {
            for(const name of fs.readdirSync(values.forms).filter(name=>/\.pdf$/i.test(name))) {
                for(const plan of planFormImports(name,[])) await saveFormPdf(db,{
                    ...plan,filename:name,content:fs.readFileSync(path.join(values.forms,name)),
                });
            }
        }
        const files=new Map();
        for(const filename of positionals) {
            const name=path.basename(filename);
            assert.ok(!files.has(name),'Input filenames must be unique');
            files.set(name,fs.readFileSync(filename));
        }
        const message={id:'offline-local-package',subject:'NEW LT FILING - offline local verification',
            from:{emailAddress:{address:'qa@example.com'}}};
        const parsed=buildFilingIntake(message,[...files].map(([name,buffer],index)=>
            ({id:String(index),name,size:buffer.length,contentType:'application/pdf'})));
        const email=db.registerEmail(message), draftId=db.createCaseDraft(email.id,parsed);
        const uploads=[];
        const upload=async(_key,filename,buffer)=>{
            uploads.push(filename);
            return {fileName:filename,driveId:'offline',itemId:filename,
                webUrl:'https://onedrive.example/'+encodeURIComponent(filename)};
        };
        const dependencies={extract:extractComplaintPdf,forms:{upload},download:input=>downloadIntakeDocuments(input,{
            download:async source=>{
                const content=files.get(emailAttachmentSourceName(source.downloadUrl));
                assert.ok(content,'Only supplied local PDFs may be read');return content;
            },upload,wait:async()=>{},
        })};
        let detail=await processFilingIntake(db,email.id,draftId,parsed,dependencies);
        assert.ok(detail.caseDraft.complaintExtraction,'The current extractor result must survive database readback');
        const uploadCount=uploads.length;
        await processFilingIntake(db,email.id,draftId,parsed,dependencies);
        assert.equal(uploads.length,uploadCount,'A repeated intake must not duplicate PDFs');
        const source=detail.documents.find(document=>document.isPrimary);
        assert.ok(source,'The system must identify the primary Complaint automatically');
        const filing=structuredClone(detail.caseDraft.filingData);
        filing.plaintiff.phone='248-555-0101';
        db.updateCaseDraft(draftId,{},undefined,filing);
        await ensureDraftComplaintExtraction(db,draftId,{force:true,content:files.get(source.originalFilename)});
        detail=db.getDraftDetail(draftId);
        assert.ok(detail.caseDraft.complaintExtraction,'Re-extraction evidence must remain stored');
        assert.equal(detail.caseDraft.filingData.plaintiff.phone,'248-555-0101','Re-reading must preserve manual corrections');
        if(values['expect-review']) assert.equal(db.queueValidatedIntakes(),0,'An uncertain scan must not be queued automatically');
        assert.equal(db.listFilingJobs().length,0);
        assert.equal(networkAttempts,0);
        const report={sourcePdfs:files.size,pdfCount:detail.documents.length,uploads:uploadCount,
            networkAttempts,filingJobs:0,manualOverridePreserved:true,reprocessingIdempotent:true,
            extraction:detail.caseDraft.complaintExtraction,fields:detail.caseDraft.filingData,
            issues:detail.caseDraft.validationIssues,documents:detail.documents.map(document=>({
                filename:document.originalFilename,role:document.packageRole,status:document.status,recognition:document.recognition,
            }))};
        fs.mkdirSync(path.dirname(path.resolve(values.output)),{recursive:true});
        fs.writeFileSync(values.output,JSON.stringify(report,null,2));
        console.log(JSON.stringify({...report,extraction:undefined,fields:undefined,documents:report.documents}));
    } finally {
        db.close();
        assert.equal(path.dirname(path.resolve(temporary)),path.resolve(os.tmpdir()));
        assert.ok(path.basename(temporary).startsWith('local-intake-qa-'));
        fs.rmSync(temporary,{recursive:true,force:true});
    }
})().catch(error=>{console.error(error);process.exitCode=1;});
