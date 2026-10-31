import assert from 'node:assert/strict';
import test from 'node:test';
import { ADAM_OFFICE, approvedSupportingRelation } from './adamFilingPolicy';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { WorkflowDatabase } from './database';
import { buildFilingIntake } from './filingIntake';
import { processFilingIntake } from './filingIntakeWorker';
import { recognizeDocumentText, recognizeDocumentPdf, type DocumentRecognition } from './documentRecognition';
import { CURRENT_COMPLAINT_EXTRACTOR_VERSION, type ComplaintExtractionResult } from './complaintExtractor';
import { ensureDraftComplaintExtraction, ensureDraftDocumentRecognitions } from './draftExtraction';
import { testPdfFixture, testComplaintFormFixture } from './testPdfFixture';
import { validCompletenessSnapshot } from './packageCompleteness';

const court = 'MI Example County - 25th District Court';
const otherCourt = 'MI Example County - 29th District Court';
const coreTitles: Record<string,string> = {
    Complaint:'COMPLAINT NONPAYMENT OF RENT',
    Advice:'Advice of Rights and Information (Landlord-Tenant)',
    Local:'Local Rental and Housing Information',
    Summons:'Summons, Landlord-Tenant/Land Contract',
    Request:'Request for Court Mailing and Record (Landlord-Tenant)',
};

function syntheticDocument(title:string,filename:string) {
    const pdf=testPdfFixture(title);
    const recognition:DocumentRecognition={...recognizeDocumentText([title],filename),
        contentHash:createHash('sha256').update(pdf).digest('hex'),recognitionVersion:2};
    return {pdf,recognition};
}

function padPdf(pdf:Buffer,bytes:number):Buffer {
    assert.ok(pdf.length<=bytes,'The synthetic PDF must fit the unchanged source size');
    return Buffer.concat([pdf,Buffer.alloc(bytes-pdf.length,0x20)]);
}

const demandPdf = testPdfFixture('DEMAND FOR POSSESSION NONPAYMENT OF RENT');
const demandRecognition: DocumentRecognition = {
    role:'ancillary',source:'content',supportingKind:'demand',
    contentHash:createHash('sha256').update(demandPdf).digest('hex'),recognitionVersion:2,
    message:'Synthetic Demand title verified from fixture content.',
};
const deedPdf = testPdfFixture("SHERIFF'S DEED");
const deedRecognition: DocumentRecognition = {
    role:'ancillary',source:'content',supportingKind:'deed',
    contentHash:createHash('sha256').update(deedPdf).digest('hex'),recognitionVersion:2,
    message:'Synthetic Sheriff deed title verified from fixture content.',
};
const extraction: ComplaintExtractionResult = {
    extractorVersion:3,extractionMethod:'form_fields',formType:'NONPAYMENT OF RENT',pageCount:1,textHash:'qa-v1',
    data:{courtDistrict:'25',relatedCivilAction:'none',moneyJudgmentRequested:false,claimAmount:'0.00',mailingRequested:true,
        plaintiff:{displayName:'Example Owner LLC',entityName:'Example Owner LLC',address1:'100 Main Street',city:'Lincoln Park',state:'MI',postalCode:'48146'},
        defendants:[{displayName:'Morgan Tenant',firstName:'Morgan',lastName:'Tenant',address1:'200 Main Street',city:'Lincoln Park',state:'MI',postalCode:'48146'}]},
    fieldConfidence:{},warnings:[],
};

function fixture(initialCourt: string | null = court, packageMode?: 'standard_lt' | 'custom') {
    const directory=fs.mkdtempSync(path.join(os.tmpdir(),'draft-documents-'));
    const db=new WorkflowDatabase(path.join(directory,'workflow.sqlite'));
    const message={id:'qa-package',subject:'NEW LT FILING - Example',from:{emailAddress:{address:'qa@example.com'}}};
    const parsed={...buildFilingIntake(message,[]),courtName:initialCourt};
    if(packageMode) {
        parsed.intake!.manual=true;
        parsed.intake!.packageMode=packageMode;
    }
    const email=db.registerEmail(message);
    const draftId=db.createCaseDraft(email.id,parsed);
    const add=(type:string,name=type+'.pdf',status:'uploaded'|'failed'='uploaded',document?:{pdf:Buffer;recognition:DocumentRecognition})=>{
        const content=document || syntheticDocument(coreTitles[type] || type,name);
        return db.addDocument({
            emailId:email.id,caseDraftId:draftId,originalFilename:name,currentFilename:name,documentType:type,
            status,uploadSource:'email_intake',sourceUrl:'email-attachment://qa/'+encodeURIComponent(name),
            oneDriveUrl:status==='uploaded'?'https://onedrive.example/'+encodeURIComponent(name):null,
            fileSize:content.pdf.length,metadata:status==='uploaded'?{recognition:content.recognition}:undefined,
        });
    };
    const complaint=add('Complaint');
    for(const role of ['Advice','Local','Summons','Request'])add(role);
    const ancillary=add('Ancillary document','Demand.pdf','uploaded',{pdf:demandPdf,recognition:demandRecognition});
    db.applyComplaintExtraction(draftId,complaint,extraction);
    db.markEmailProcessed(email.id);
    return {db,parsed,email,draftId,complaint,ancillary,add,close(){db.close();fs.rmSync(directory,{recursive:true,force:true});}};
}

test('conflicting Complaint source values block preparation until corrected and preserve the manual correction', () => {
    const f=fixture();
    try {
        f.db.updateCaseDraft(f.draftId,{},undefined,undefined,[{id:f.ancillary,filingType:'Other',filingRelation:'separate'}]);
        const current=structuredClone(extraction);
        current.extractorVersion=CURRENT_COMPLAINT_EXTRACTOR_VERSION;
        current.data.moneyJudgmentRequested=true;delete current.data.claimAmount;
        current.warnings=[{code:'source_conflict',field:'claimAmount',message:'Different totals occur in the source Complaint.'}];
        const blocked=f.db.applyComplaintExtraction(f.draftId,f.complaint,current);
        assert.equal(blocked.caseDraft!.filingData.claimAmount,null);
        const issue=blocked.caseDraft!.validationIssues.find(item=>item.field==='complaintExtraction.source_conflict.claimAmount');
        assert.equal(issue?.severity,'error');assert.equal(issue?.reviewField,'filingData.claimAmount');
        assert.throws(()=>f.db.queueFilingJob(f.draftId,'prepare','admin','admin',true),/Cannot approve draft/);
        const manual={...blocked.caseDraft!.filingData,claimAmount:'850.00'};
        f.db.updateCaseDraft(f.draftId,{},undefined,manual);
        const reread=f.db.applyComplaintExtraction(f.draftId,f.complaint,current);
        assert.equal(reread.caseDraft!.filingData.claimAmount,'850.00');
        assert.ok(!reread.caseDraft!.validationIssues.some(item=>item.field.includes('source_conflict')));
        assert.equal(f.db.queueValidatedIntakes(),0);
        const job=f.db.queueFilingJob(f.draftId,'prepare','admin','admin',true);
        assert.equal(job.payload!.filingData.claimAmount,'850.00');
    } finally { f.close(); }
});

test('a manual contact edit cannot waive conflicting party fields from a merged Complaint', () => {
    const f=fixture();
    try {
        const conflicted:ComplaintExtractionResult={...structuredClone(extraction),extractorVersion:CURRENT_COMPLAINT_EXTRACTOR_VERSION,
            warnings:[{code:'source_conflict' as const,field:'plaintiff' as const,message:'Replace the conflicting Plaintiff PDF fields.'}]};
        const blocked=f.db.applyComplaintExtraction(f.draftId,f.complaint,conflicted);
        f.db.updateCaseDraft(f.draftId,{},undefined,{...blocked.caseDraft!.filingData,
            plaintiff:{...blocked.caseDraft!.filingData.plaintiff,phone:'248-555-0109'}});
        const reread=f.db.applyComplaintExtraction(f.draftId,f.complaint,conflicted);
        assert.equal(reread.caseDraft!.filingData.plaintiff.phone,'248-555-0109');
        assert.ok(reread.caseDraft!.validationIssues.some(issue=>issue.field==='complaintExtraction.source_conflict.plaintiff'&&issue.severity==='error'));
        assert.throws(()=>f.db.queueFilingJob(f.draftId,'prepare','admin','admin',true),/Cannot approve draft/);
    } finally { f.close(); }
});

for(const district of ['25','45']) {
test(`five supplied supporting PDFs remain distinct and use the approved ${district==='45'?'Connected':'Other'} court route`,async()=>{
    const f=fixture(`MI Example County - ${district}th District Court`);
    try {
        f.db.recordDocumentRecognition(f.ancillary,deedRecognition);
        for(let index=1;index<=4;index++) {
            const filename='Supporting '+index+'.pdf',pdf=testPdfFixture('Case evidence '+index+' supplied by the attorney. Additional materials for this filing package. '.repeat(2));
            const recognition=await recognizeDocumentPdf(pdf,filename);
            const id=f.add('Unclassified PDF',filename,'uploaded',{pdf,recognition});
            f.db.recordDocumentRecognition(id,recognition);
        }
        f.db.applyComplaintExtraction(f.draftId,f.complaint,{...structuredClone(extraction),extractorVersion:CURRENT_COMPLAINT_EXTRACTOR_VERSION,
            data:{...structuredClone(extraction.data),courtDistrict:district}});
        const detail=f.db.applyCourtFilingRule(f.draftId);
        assert.deepEqual(detail.caseDraft!.validationIssues,[]);
        const supporting=detail.documents.filter(document=>document.packageRole==='ancillary');
        assert.equal(supporting.length,5);assert.equal(new Set(supporting.map(document=>document.oneDriveUrl)).size,5);
        assert.ok(supporting.every(document=>document.filingType==='Other' && document.filingRelation===
            (district==='45'?'connected_to_complaint':'separate')));
        assert.ok(!supporting.some(document=>document.supportingEvidence!.kind==='demand'));
        assert.equal(detail.documents.length,10);
        const job=f.db.queueFilingJob(f.draftId,'prepare','admin','admin',true);
        assert.equal(job.payload!.documents.length,10);assert.equal(validCompletenessSnapshot(job.payload!),true);
        assert.equal(job.mode,'prepare');
    }finally{f.close();}
});
}

test('the supplied-package policy keeps every standard core PDF and at least one supporting PDF mandatory',()=>{
    for(const role of ['complaint','advice','local','summons','request','ancillary']) {
        const f=fixture();
        try {
            const document=f.db.getDraftDetail(f.draftId)!.documents.find(document=>document.packageRole===role)!;
            const detail=f.db.removeDraftDocument(f.draftId,document.id);
            assert.ok(detail.caseDraft!.validationIssues.some(issue=>issue.field==='package.'+role));
            assert.throws(()=>f.db.queueFilingJob(f.draftId,'prepare','admin','admin',true),/Cannot approve draft/);
            assert.equal(f.db.listFilingJobs(f.draftId).length,0);
        }finally{f.close();}
    }
});

test('an unreadable supporting PDF or out-of-scope Motion cannot be certified by selecting Other',()=>{
    for(const recognition of [{...deedRecognition,pdfVerified:false},{...deedRecognition,outOfScope:true}]) {
        const f=fixture();
        try {
            f.db.recordDocumentRecognition(f.ancillary,recognition);
            const detail=f.db.updateCaseDraft(f.draftId,{},undefined,undefined,[{id:f.ancillary,filingType:'Other',filingRelation:'separate',filingTypeReviewed:true}]);
            assert.ok(detail.caseDraft!.validationIssues.some(issue=>issue.field==='document.'+f.ancillary));
            assert.throws(()=>f.db.queueFilingJob(f.draftId,'prepare','admin','admin',true),/Cannot approve draft/);
        }finally{f.close();}
    }
});

test('a changed content pin clears prior approval and cannot automatically prepare the updated package',()=>{
    const f=fixture();
    try {
        f.db.applyComplaintExtraction(f.draftId,f.complaint,{...extraction,extractorVersion:CURRENT_COMPLAINT_EXTRACTOR_VERSION});
        f.db.applyCourtFilingRule(f.draftId);f.db.reviewCaseDraft(f.draftId,'approve');
        const old=f.db.buildFilingPayload(f.draftId);
        f.db.recordDocumentRecognition(f.ancillary,deedRecognition);
        const current=f.db.getDraftDetail(f.draftId)!;
        assert.equal(current.caseDraft!.reviewedAt,null);
        assert.equal(JSON.parse(current.caseDraft!.normalizedDataJson!).manualDocumentEdits,true);
        assert.equal(f.db.queueValidatedIntakes(),0);
        assert.throws(()=>f.db.queueFilingJob(f.draftId),/Approve the Draft/);
        assert.equal(validCompletenessSnapshot({...f.db.buildFilingPayload(f.draftId),completeness:old.completeness}),false);
    }finally{f.close();}
});

test('existing unstarted intakes are not bulk requeued when the supplied-package policy changes',()=>{
    const f=fixture();
    try {
        f.db.applyComplaintExtraction(f.draftId,f.complaint,{...extraction,extractorVersion:CURRENT_COMPLAINT_EXTRACTOR_VERSION});
        f.db.applyCourtFilingRule(f.draftId);f.db.recordDocumentRecognition(f.ancillary,deedRecognition);
        (f.db as any).db.prepare("UPDATE case_drafts SET normalized_data_json=json_remove(normalized_data_json,'$.supportingPolicyVersion','$.manualDocumentEdits') WHERE id=?").run(f.draftId);
        const detail=f.db.refreshCaseDraftValidation(f.draftId);
        assert.deepEqual(detail.caseDraft!.validationIssues,[]);assert.equal(detail.caseDraft!.status,'ready_to_file');
        assert.equal(f.db.queueValidatedIntakes(),0);assert.equal(f.db.listFilingJobs(f.draftId).length,0);
        const job=f.db.queueFilingJob(f.draftId,'prepare','admin','admin',true);
        assert.equal(job.mode,'prepare');assert.equal(validCompletenessSnapshot(job.payload!),true);
    }finally{f.close();}
});

test('legacy unclassified PDFs are freshly inspected before receiving the supplied-supporting fallback',async()=>{
    const f=fixture();
    try {
        const pdf=testPdfFixture('Additional supporting evidence retained exactly as provided by the attorney. '.repeat(3));
        f.db.recordDocumentRecognition(f.ancillary,{role:'unknown',source:'unknown',textSource:'pdf',recognitionVersion:2,
            contentHash:createHash('sha256').update(pdf).digest('hex'),message:'Legacy unclassified PDF'});
        assert.ok(f.db.listPendingDocumentRecognitions().includes(f.draftId));
        let reads=0;
        const detail=await ensureDraftDocumentRecognitions(f.db,f.draftId,async()=>{reads++;return pdf;});
        assert.equal(reads,1);
        const supporting=detail.documents.find(document=>document.id===f.ancillary)!;
        assert.equal(supporting.packageRole,'ancillary');assert.equal(supporting.filingType,'Other');
        assert.equal(supporting.recognition!.pdfVerified,true);assert.equal(supporting.recognition!.source,'supplied');
        assert.ok(!f.db.listPendingDocumentRecognitions().includes(f.draftId));
    }finally{f.close();}
});

test('legacy recognition refresh re-extracts changed Complaint bytes at a stable OneDrive URL without overwriting manual fields',async()=>{
    const f=fixture();
    try {
        const replacement=testComplaintFormFixture({5:'Current Owner LLC',
            6:'Adam Devlin P72877\r30850 Telegraph Rd Ste 250\rBingham Farms, MI 48025\r248 703 6201',32:'Off'});
        const original=padPdf(testPdfFixture('COMPLAINT'),replacement.length);
        const oldHash=createHash('sha256').update(original).digest('hex'),newHash=createHash('sha256').update(replacement).digest('hex');
        (f.db as any).db.prepare('UPDATE document_records SET file_size=? WHERE id=?').run(original.length,f.complaint);
        f.db.recordDocumentRecognition(f.complaint,{...recognizeDocumentText(['COMPLAINT'],'Complaint.pdf'),
            contentHash:oldHash,recognitionVersion:1});
        f.db.applyComplaintExtraction(f.draftId,f.complaint,{...structuredClone(extraction),
            extractorVersion:CURRENT_COMPLAINT_EXTRACTOR_VERSION,contentHash:oldHash});
        const initial=f.db.getDraftDetail(f.draftId)!,version=f.db.getComplaintSourceVersion(f.complaint);
        f.db.updateCaseDraft(f.draftId,{},undefined,{...initial.caseDraft!.filingData,
            plaintiff:{...initial.caseDraft!.filingData.plaintiff,phone:'248-555-0101'}});
        const record=f.db.recordDocumentRecognition.bind(f.db);
        let guarded=false,downloads=0;
        f.db.recordDocumentRecognition=(id,result)=>{
            if(id===f.complaint) {
                const root=JSON.parse(f.db.getDraftDetail(f.draftId)!.caseDraft!.normalizedDataJson!);
                assert.equal(root.complaintAutoExtraction.status,'running');
                assert.equal(f.db.queueValidatedIntakes(),0);
                guarded=true;
            }
            record(id,result);
        };
        const result=await ensureDraftDocumentRecognitions(f.db,f.draftId,async url=>{
            downloads++;assert.equal(url,initial.documents.find(doc=>doc.id===f.complaint)!.oneDriveUrl);return replacement;
        });
        assert.equal(downloads,1);assert.equal(guarded,true);
        assert.equal(f.db.getComplaintSourceVersion(f.complaint),version);
        assert.equal(result.caseDraft!.complaintExtraction!.contentHash,newHash);
        assert.equal(result.documents.find(doc=>doc.id===f.complaint)!.recognition!.contentHash,newHash);
        assert.equal(result.caseDraft!.filingData.plaintiff.entityName,'Current Owner LLC');
        assert.equal(result.caseDraft!.filingData.plaintiff.phone,'248-555-0101');
        const reused=await ensureDraftComplaintExtraction(f.db,f.draftId,{content:replacement,
            extract:async()=>{throw new Error('An already verified identical Complaint must be reused');}});
        assert.equal(JSON.parse(reused.caseDraft!.normalizedDataJson!).complaintExtractionError,undefined);
        assert.equal(f.db.listFilingJobs(f.draftId).length,0);
    }finally{f.close();}
});

test('a legacy primary PDF replaced by a deed cannot reuse old Complaint facts through a manual Filing Type',async()=>{
    const f=fixture();
    try {
        f.db.recordDocumentRecognition(f.complaint,{...recognizeDocumentText(['COMPLAINT'],'Complaint.pdf'),recognitionVersion:1,
            contentHash:createHash('sha256').update(testPdfFixture('COMPLAINT')).digest('hex')});
        f.db.updateCaseDraft(f.draftId,{},undefined,undefined,[{id:f.complaint,filingType:'Complaint for Possession Only',filingRelation:'separate'}]);
        const result=await ensureDraftDocumentRecognitions(f.db,f.draftId,async()=>deedPdf);
        const root=JSON.parse(result.caseDraft!.normalizedDataJson!);
        assert.match(root.complaintExtractionError,/primary PDF changed/);
        assert.equal(result.documents.find(doc=>doc.id===f.complaint)!.recognition!.contentHash,deedRecognition.contentHash);
        assert.ok(result.caseDraft!.validationIssues.some(issue=>issue.severity==='error' && issue.message.includes('primary PDF changed')));
        assert.equal(f.db.queueValidatedIntakes(),0);
        assert.throws(()=>f.db.buildFilingPayload(f.draftId),/blocked/);
    }finally{f.close();}
});

test('a newly pinned Complaint invalidates an older extraction still in flight at the same URL',async()=>{
    const f=fixture();let release!:()=>void;
    const gate=new Promise<void>(resolve=>{release=resolve;});
    let started!:()=>void;const entered=new Promise<void>(resolve=>{started=resolve;});
    let pending:ReturnType<typeof ensureDraftComplaintExtraction>|undefined;
    try {
        const original=syntheticDocument(coreTitles.Complaint,'Complaint.pdf').pdf;
        const replacement=testComplaintFormFixture({5:'Newly Pinned Owner LLC'});
        const newer={...recognizeDocumentText(['COMPLAINT'],'Complaint.pdf'),
            contentHash:createHash('sha256').update(replacement).digest('hex'),recognitionVersion:2};
        pending=ensureDraftComplaintExtraction(f.db,f.draftId,{content:original,force:true,extract:async()=>{
            started();await gate;return {...structuredClone(extraction),extractorVersion:CURRENT_COMPLAINT_EXTRACTOR_VERSION,textHash:'stale-in-flight'};
        }});
        await entered;
        f.db.recordDocumentRecognition(f.complaint,newer);
        release();await pending;
        const result=f.db.getDraftDetail(f.draftId)!;
        assert.notEqual(result.caseDraft!.complaintExtraction!.textHash,'stale-in-flight');
        assert.match(JSON.parse(result.caseDraft!.normalizedDataJson!).complaintExtractionError,/contents changed during extraction/);
        assert.equal(f.db.queueValidatedIntakes(),0);
    }finally{release();if(pending)await pending;f.close();}
});

test('attorney-confirmed contacts fill missing Plaintiff data without overwriting manual blanks',()=>{
    const f=fixture();
    try {
        const missing=structuredClone(extraction);
        missing.data.plaintiff={displayName:'Example Owner LLC',entityName:'Example Owner LLC'};
        missing.data.defendants=[{displayName:'Example Ventures LLC',partyType:'entity',entityName:'Example Ventures LLC',
            address1:'200 Main Street',city:'Lincoln Park',state:'MI',postalCode:'48146'}];
        let detail=f.db.applyComplaintExtraction(f.draftId,f.complaint,missing);
        const filing=detail.caseDraft!.filingData;
        for(const [key,value] of Object.entries(ADAM_OFFICE)) assert.equal((filing.plaintiff as any)[key],value);
        assert.equal(filing.defendants[0].partyType,'entity');
        assert.equal(filing.defendants[0].entityName,'Example Ventures LLC');
        assert.equal(filing.attorney.barNumber,'P72877');
        f.db.updateCaseDraft(f.draftId,{},undefined,{...filing,plaintiff:{...filing.plaintiff,address1:null,email:'manual@example.com'}});
        detail=f.db.applyComplaintExtraction(f.draftId,f.complaint,missing);
        assert.equal(detail.caseDraft!.filingData.plaintiff.address1,null);
        assert.equal(detail.caseDraft!.filingData.plaintiff.email,'manual@example.com');
    } finally {f.close();}
});

test('approved court defaults distinguish divisions and respect saved and disabled overrides',()=>{
    for(const code of ['45th','17th','47th','41A-1','18th','1st','32A','71A','54A','66th','56A','73A'])
        assert.equal(approvedSupportingRelation(`MI Example County - ${code} District Court`),'connected_to_complaint',code);
    assert.equal(approvedSupportingRelation('MI Example County - 41A-2 District Court'),'separate');
    assert.equal(approvedSupportingRelation('MI Example County - 41A District Court'),null);
    assert.equal(approvedSupportingRelation('41A1'),null);
    const f=fixture();
    try {
        let detail=f.db.applyCourtFilingRule(f.draftId);
        assert.equal(detail.documents.find(d=>d.id===f.ancillary)!.filingRelation,'separate');
        assert.match(f.db.listCourtFilingRules()[0].id,/adam-confirmed/);
        const rule=f.db.saveCourtFilingRule({courtName:court,relation:'manual_review',confirmed:true});
        detail=f.db.applyCourtFilingRule(f.draftId,true);
        assert.equal(detail.documents.find(d=>d.id===f.ancillary)!.filingRelation,'unknown');
        f.db.disableCourtFilingRule(rule.id);
        detail=f.db.applyCourtFilingRule(f.draftId,true);
        assert.equal(detail.documents.find(d=>d.id===f.ancillary)!.filingRelation,'unknown');
        assert.equal(f.db.listCourtFilingRules().length,0,'disabled override must not reactivate the default');
    } finally {f.close();}
});

test('one confirmation reviews and queues a complete package, rejects duplicates and stale snapshots',()=>{
    const f=fixture();
    try {
        f.db.updateCaseDraft(f.draftId,{},undefined,undefined,[{id:f.ancillary,filingRelation:'separate',filingType:'Other'}]);
        const before=f.db.getDraftDetail(f.draftId)!.caseDraft!;
        assert.equal(before.reviewedAt,null);
        assert.throws(()=>f.db.queueFilingJob(f.draftId,'prepare','admin','admin',true,'stale-version'),/Draft changed/);
        assert.equal(f.db.getDraftDetail(f.draftId)!.caseDraft!.reviewedAt,null);
        const job=f.db.queueFilingJob(f.draftId,'prepare','admin','admin',true,before.updatedAt);
        assert.equal(job.mode,'prepare');
        assert.equal(job.payload!.documents.length,6);
        assert.ok(f.db.getDraftDetail(f.draftId)!.caseDraft!.reviewedAt);
        assert.throws(()=>f.db.queueFilingJob(f.draftId,'prepare','admin','admin',true),/Resolve or complete/);
        assert.equal(f.db.listFilingJobs(f.draftId).length,1);
    } finally { f.close(); }
});

test('combined confirmation cannot approve an incomplete package or enable final submission',()=>{
    const f=fixture();
    try {
        assert.throws(()=>f.db.queueFilingJob(f.draftId,'prepare','admin','admin',true),/Cannot approve/);
        assert.equal(f.db.getDraftDetail(f.draftId)!.caseDraft!.reviewedAt,null);
        assert.equal(f.db.listFilingJobs(f.draftId).length,0);
        assert.throws(()=>f.db.queueFilingJob(f.draftId,'submit' as any,'admin','admin',true),/Final court submission is disabled/);
    } finally { f.close(); }
});

test('combined confirmation rolls back review if payload creation fails',()=>{
    const f=fixture();
    try {
        f.db.updateCaseDraft(f.draftId,{},undefined,undefined,[{id:f.ancillary,filingRelation:'separate',filingType:'Other'}]);
        f.db.buildFilingPayload=()=>{throw new Error('Simulated snapshot failure');};
        assert.throws(()=>f.db.queueFilingJob(f.draftId,'prepare','admin','admin',true),/snapshot failure/);
        assert.equal(f.db.getDraftDetail(f.draftId)!.caseDraft!.reviewedAt,null);
        assert.equal(f.db.listFilingJobs(f.draftId).length,0);
    } finally { f.close(); }
});

test('every included core PDF needs its own content hash before package approval',()=>{
    for(const role of Object.keys(coreTitles)) {
        const f=fixture();
        try {
            f.db.updateCaseDraft(f.draftId,{},undefined,undefined,[{id:f.ancillary,filingType:'Other',filingRelation:'separate'}]);
            const before=f.db.getDraftDetail(f.draftId)!;
            assert.deepEqual(before.caseDraft!.validationIssues,[]);
            assert.ok(before.documents.every(document=>document.recognition?.source==='content' &&
                document.recognition.recognitionVersion===2 && /^[a-f0-9]{64}$/.test(document.recognition.contentHash || '')));
            const document=before.documents.find(item=>item.packageRole===role.toLowerCase())!;
            assert.ok(document,role);
            f.db.recordDocumentRecognition(document.id,recognizeDocumentText([coreTitles[role]],document.originalFilename!));
            f.db.updateCaseDraft(f.draftId,{},undefined,undefined,[{id:document.id,
                filingType:document.filingType,filingRelation:document.filingRelation,filingTypeReviewed:true}]);
            const unpinned=f.db.refreshCaseDraftValidation(f.draftId);
            assert.equal(unpinned.documents.find(item=>item.id===document.id)!.recognition!.contentHash,undefined);
            assert.ok(unpinned.caseDraft!.validationIssues.some(issue=>/Every included PDF must be pinned/.test(issue.message)),role);
            assert.throws(()=>f.db.reviewCaseDraft(f.draftId,'approve'),/Every included PDF must be pinned/);
            assert.throws(()=>f.db.buildFilingPayload(f.draftId),/Every included PDF must be pinned/);
            assert.equal(f.db.listFilingJobs(f.draftId).length,0);
        } finally { f.close(); }
    }
});

test('stale semantic edits cannot change a replacement PDF, while a newly pinned deed needs no Demand exception',()=>{
    const f=fixture();
    try {
        f.db.updateCaseDraft(f.draftId,{},undefined,undefined,[{id:f.ancillary,filingType:'Other',filingRelation:'separate'}]);
        const original=f.db.getDraftDetail(f.draftId)!.documents.find(item=>item.id===f.ancillary)!;
        const replacementPdf=padPdf(deedPdf,original.fileSize!);
        const replacementRecognition:DocumentRecognition={...deedRecognition,
            contentHash:createHash('sha256').update(replacementPdf).digest('hex')};
        const reservation=f.db.beginDocumentReplacement(f.ancillary);
        f.db.recordDocumentReplacement(f.ancillary,{token:reservation.token,fileSize:replacementPdf.length,oneDriveUrl:original.oneDriveUrl!});
        f.db.recordDocumentRecognition(f.ancillary,replacementRecognition);
        const changed=f.db.updateCaseDraft(f.draftId,{},undefined,undefined,[{id:f.ancillary,filingType:'Other',filingRelation:'separate'}]);
        const current=changed.documents.find(item=>item.id===f.ancillary)!;
        assert.equal(current.oneDriveUrl,original.oneDriveUrl);
        assert.equal(current.fileSize,original.fileSize);
        assert.notEqual(current.sourceVersion,original.sourceVersion);
        assert.notEqual(current.recognition!.contentHash,original.recognition!.contentHash);
        for(const expected of [
            {expectedSourceVersion:original.sourceVersion,expectedContentHash:original.recognition!.contentHash},
            {expectedSourceVersion:original.sourceVersion,expectedContentHash:current.recognition!.contentHash},
            {expectedSourceVersion:current.sourceVersion,expectedContentHash:original.recognition!.contentHash},
        ]) {
            const before=f.db.getDraftDetail(f.draftId)!;
            assert.throws(()=>f.db.updateCaseDraft(f.draftId,{caseTitle:'Stale semantic review must not persist'},
                'Stale note must not persist',undefined,[{id:f.ancillary,filingName:'Stale Demand label',
                    filingType:'Other',filingRelation:'separate',supportingKind:'demand',supportingKindReviewed:true,...expected}]),
            /PDF changed since its contents were reviewed/);
            assert.deepEqual(f.db.getDraftDetail(f.draftId),before,'the stale request must roll back all Draft and document edits');
        }
        const final=f.db.getDraftDetail(f.draftId)!;
        assert.deepEqual(final.documents.find(item=>item.id===f.ancillary)!.supportingEvidence,{
            kind:'deed',source:'content',contentHash:replacementRecognition.contentHash,
        });
        assert.equal(final.caseDraft!.reviewedAt,null);
        assert.deepEqual(final.caseDraft!.validationIssues,[]);
        f.db.reviewCaseDraft(f.draftId,'approve');
        assert.equal(f.db.listFilingJobs(f.draftId).length,0);
    } finally { f.close(); }
});

test('same-size stable-URL replacements retain a new durable source version after completion',()=>{
    const f=fixture();
    try {
        const original=f.db.getDraftDetail(f.draftId)!.documents.find(item=>item.id===f.ancillary)!;
        let previousVersion=original.sourceVersion;
        for(let generation=0;generation<2;generation++) {
            const reservation=f.db.beginDocumentReplacement(f.ancillary);
            const inProgress=f.db.getComplaintSourceVersion(f.ancillary);
            assert.notEqual(inProgress,previousVersion);
            assert.equal(JSON.parse(inProgress!)[3],reservation.token);
            f.db.recordDocumentReplacement(f.ancillary,{token:reservation.token,fileSize:original.fileSize!,oneDriveUrl:original.oneDriveUrl!});
            const completed=f.db.getDraftDetail(f.draftId)!.documents.find(item=>item.id===f.ancillary)!;
            assert.equal(completed.oneDriveUrl,original.oneDriveUrl);
            assert.equal(completed.fileSize,original.fileSize);
            assert.equal(completed.sourceVersion,inProgress,'completion must retain the last replacement token');
            assert.equal(f.db.getComplaintSourceVersion(f.ancillary),completed.sourceVersion);
            f.db.recordDocumentRecognition(f.ancillary,demandRecognition);
            assert.equal(f.db.getComplaintSourceVersion(f.ancillary),inProgress);
            assert.equal(f.db.getDraftDetail(f.draftId)!.documents.find(item=>item.id===f.ancillary)!.recognition!.contentHash,
                original.recognition!.contentHash,'even identical replacement bytes must have a new source generation');
            previousVersion=completed.sourceVersion;
        }
        assert.equal(f.db.listFilingJobs(f.draftId).length,0);
    } finally { f.close(); }
});

test('late recognition cannot restore Demand evidence over a same-size stable-URL replacement deed',async()=>{
    const f=fixture();
    let release=()=>{};
    let pending:ReturnType<typeof ensureDraftDocumentRecognitions>|undefined;
    try {
        f.db.recordDocumentRecognition(f.ancillary,{role:'ancillary',source:'filename',supportingKind:'unknown',
            recognitionVersion:1,message:'Synthetic legacy PDF waiting for recognition.'});
        const original=f.db.getDraftDetail(f.draftId)!.documents.find(item=>item.id===f.ancillary)!;
        const gate=new Promise<void>(resolve=>{release=resolve;});
        let started!:()=>void;
        const reading=new Promise<void>(resolve=>{started=resolve;});
        let downloads=0;
        pending=ensureDraftDocumentRecognitions(f.db,f.draftId,async url=>{
            downloads++;assert.equal(url,original.oneDriveUrl);started();await gate;return demandPdf;
        });
        await reading;
        const replacementPdf=padPdf(deedPdf,original.fileSize!);
        const currentRecognition:DocumentRecognition={...deedRecognition,
            contentHash:createHash('sha256').update(replacementPdf).digest('hex')};
        const reservation=f.db.beginDocumentReplacement(f.ancillary);
        f.db.recordDocumentReplacement(f.ancillary,{token:reservation.token,fileSize:original.fileSize!,oneDriveUrl:original.oneDriveUrl!});
        f.db.recordDocumentRecognition(f.ancillary,currentRecognition);
        const currentVersion=f.db.getComplaintSourceVersion(f.ancillary);
        assert.notEqual(currentVersion,original.sourceVersion);
        release();await pending;
        const final=f.db.getDraftDetail(f.draftId)!.documents.find(item=>item.id===f.ancillary)!;
        assert.equal(downloads,1);
        assert.equal(final.sourceVersion,currentVersion);
        assert.equal(final.oneDriveUrl,original.oneDriveUrl);
        assert.equal(final.fileSize,original.fileSize);
        assert.deepEqual(final.recognition,currentRecognition);
        assert.equal(final.supportingEvidence!.kind,'deed');
        assert.equal(f.db.listFilingJobs(f.draftId).length,0);
    } finally { release();if(pending)await pending;f.close(); }
});

test('late Complaint extraction cannot overwrite newer facts after a same-size stable-URL replacement',async()=>{
    const f=fixture();
    let release=()=>{};
    let pending:ReturnType<typeof ensureDraftComplaintExtraction>|undefined;
    try {
        const original=f.db.getDraftDetail(f.draftId)!.documents.find(item=>item.id===f.complaint)!;
        const gate=new Promise<void>(resolve=>{release=resolve;});
        let started!:()=>void;
        const reading=new Promise<void>(resolve=>{started=resolve;});
        const stale=structuredClone(extraction);
        stale.textHash='stale-original-extraction';
        stale.data.plaintiff={...stale.data.plaintiff,displayName:'Stale Owner LLC',entityName:'Stale Owner LLC'};
        pending=ensureDraftComplaintExtraction(f.db,f.draftId,{content:syntheticDocument(coreTitles.Complaint,'Complaint.pdf').pdf,
            force:true,extract:async()=>{started();await gate;return {...stale,extractorVersion:CURRENT_COMPLAINT_EXTRACTOR_VERSION};}});
        await reading;
        const replacementPdf=padPdf(testPdfFixture('COMPLAINT'),original.fileSize!);
        const reservation=f.db.beginDocumentReplacement(f.complaint);
        f.db.recordDocumentReplacement(f.complaint,{token:reservation.token,fileSize:replacementPdf.length,oneDriveUrl:original.oneDriveUrl!});
        f.db.recordDocumentRecognition(f.complaint,{...recognizeDocumentText(['COMPLAINT'],'Complaint.pdf'),
            contentHash:createHash('sha256').update(replacementPdf).digest('hex'),recognitionVersion:2});
        const current=structuredClone(extraction);
        current.textHash='current-replacement-extraction';
        current.data.plaintiff={...current.data.plaintiff,displayName:'Current Owner LLC',entityName:'Current Owner LLC'};
        f.db.applyComplaintExtraction(f.draftId,f.complaint,{...current,extractorVersion:CURRENT_COMPLAINT_EXTRACTOR_VERSION});
        const currentVersion=f.db.getComplaintSourceVersion(f.complaint);
        assert.notEqual(currentVersion,original.sourceVersion);
        release();await pending;
        const final=f.db.getDraftDetail(f.draftId)!;
        const document=final.documents.find(item=>item.id===f.complaint)!;
        assert.equal(document.oneDriveUrl,original.oneDriveUrl);
        assert.equal(document.fileSize,original.fileSize);
        assert.equal(document.sourceVersion,currentVersion);
        assert.equal(final.caseDraft!.filingData.plaintiff.entityName,'Current Owner LLC');
        assert.equal(final.caseDraft!.complaintExtraction!.textHash,current.textHash);
        assert.equal(JSON.parse(final.caseDraft!.normalizedDataJson!).complaintAutoExtraction,undefined);
        assert.equal(f.db.listFilingJobs(f.draftId).length,0);
    } finally { release();if(pending)await pending;f.close(); }
});

test('an old requirement context is rejected atomically after another included PDF is added',()=>{
    const f=fixture();
    try {
        f.db.updateCaseDraft(f.draftId,{},undefined,undefined,[{id:f.ancillary,filingType:'Other',filingRelation:'separate'}]);
        const oldContext=f.db.getDraftDetail(f.draftId)!.caseDraft!.packageCompleteness.contextHash;
        const deed=f.add('Ancillary document','Added Deed.pdf','uploaded',{pdf:deedPdf,recognition:deedRecognition});
        f.db.updateCaseDraft(f.draftId,{},undefined,undefined,[{id:deed,filingType:'Other',filingRelation:'separate'}]);
        f.db.reviewCaseDraft(f.draftId,'approve');
        const before=f.db.getDraftDetail(f.draftId)!;
        assert.notEqual(before.caseDraft!.packageCompleteness.contextHash,oldContext);
        assert.ok(before.caseDraft!.reviewedAt);
        assert.throws(()=>f.db.updateCaseDraft(f.draftId,{
            caseTitle:'Stale requirement review must not persist',supportingRequirement:'none',
            supportingRequirementReason:'This stale exception must not apply to a changed package.',
        },'Stale review note',undefined,[{id:f.ancillary,filingName:'Stale filing name',filingType:'Other',filingRelation:'separate'}],
        undefined,oldContext),/supporting package changed since it was reviewed/);
        assert.deepEqual(f.db.getDraftDetail(f.draftId),before,'no fields, notes, mappings, approval or audit entries may change');
        const current=f.db.updateCaseDraft(f.draftId,{supportingRequirement:'demand',
            supportingRequirementReason:'Attorney reviewed the current PDFs and verified the included Demand.'},
        undefined,undefined,[],undefined,before.caseDraft!.packageCompleteness.contextHash);
        assert.equal(current.caseDraft!.packageCompleteness.source,'attorney_policy');
        assert.equal(current.caseDraft!.packageCompleteness.requirement,'supplied');
        assert.equal(current.caseDraft!.packageCompleteness.reviewStale,false);
        assert.deepEqual(current.caseDraft!.validationIssues,[]);
        assert.equal(f.db.listFilingJobs(f.draftId).length,0);
    } finally { f.close(); }
});

for(const packageMode of ['standard_lt','custom'] as const) {
test(`${packageMode} supplied deed passes as Other without a separate Demand`,()=>{
    const f=fixture(court,packageMode);
    try {
        f.db.recordDocumentRecognition(f.ancillary,deedRecognition);
        const detail=f.db.updateCaseDraft(f.draftId,{},undefined,undefined,[{
            id:f.ancillary,filingType:'Other',filingTypeReviewed:true,filingRelation:'separate',
        }]);
        const document=detail.documents.find(item=>item.id===f.ancillary)!;
        assert.equal(detail.caseDraft!.manualPackage,packageMode==='custom');
        assert.equal(document.filingType,'Other');
        assert.equal(document.filingTypeSource,'manual');
        assert.deepEqual(document.supportingEvidence,{
            kind:'deed',source:'content',contentHash:deedRecognition.contentHash,
        });
        assert.equal(detail.caseDraft!.packageCompleteness.requirement,'supplied');
        assert.deepEqual(detail.caseDraft!.validationIssues,[]);
        assert.equal(f.db.buildFilingPayload(f.draftId).documents.length,6);
        assert.equal(f.db.queueValidatedIntakes(),0);
        assert.equal(f.db.getDraftDetail(f.draftId)!.caseDraft!.reviewedAt,null);
        assert.equal(f.db.listFilingJobs(f.draftId).length,0);
        const job=f.db.queueFilingJob(f.draftId,'prepare','admin','admin',true);
        assert.equal(job.mode,'prepare');assert.equal(validCompletenessSnapshot(job.payload!),true);
    } finally { f.close(); }
});
}

test('legacy Demand exception fields are optional metadata and cannot bypass PDF pins or manual confirmation',()=>{
    const f=fixture();
    const reason='Attorney reviewed this synthetic package and confirmed no Demand or Notice is required.';
    try {
        f.db.applyComplaintExtraction(f.draftId,f.complaint,{...extraction,extractorVersion:CURRENT_COMPLAINT_EXTRACTOR_VERSION});
        f.db.recordDocumentRecognition(f.ancillary,deedRecognition);
        f.db.updateCaseDraft(f.draftId,{},undefined,undefined,[{id:f.ancillary,filingType:'Other',filingRelation:'separate'}]);
        for(const invalidReason of [null,'Short']) {
            const invalid=f.db.updateCaseDraft(f.draftId,{supportingRequirement:'none',supportingRequirementReason:invalidReason});
            assert.equal(invalid.caseDraft!.packageCompleteness.requirement,'supplied');
            assert.equal(invalid.caseDraft!.packageCompleteness.source,'attorney_policy');
            assert.deepEqual(invalid.caseDraft!.packageCompleteness.issues,[]);
            assert.equal(f.db.getDraftDetail(f.draftId)!.caseDraft!.reviewedAt,null);
            assert.equal(f.db.listFilingJobs(f.draftId).length,0);
        }
        const reviewed=f.db.updateCaseDraft(f.draftId,{supportingRequirement:'none',supportingRequirementReason:reason});
        assert.deepEqual(reviewed.caseDraft!.validationIssues,[]);
        assert.equal(reviewed.caseDraft!.packageCompleteness.reason,null);
        assert.equal(reviewed.caseDraft!.reviewedAt,null);
        assert.throws(()=>f.db.queueFilingJob(f.draftId),/Approve the Draft/);
        const ready=f.db.refreshCaseDraftValidation(f.draftId);
        assert.equal(ready.caseDraft!.status,'ready_to_file');
        assert.equal(JSON.parse(ready.caseDraft!.normalizedDataJson!).manualDocumentEdits,true);
        assert.equal(f.db.queueValidatedIntakes(),0,'manual completeness decisions must not enter automatic preparation');
        assert.equal(f.db.listFilingJobs(f.draftId).length,0);
        const job=f.db.queueFilingJob(f.draftId,'prepare','admin','admin',true,ready.caseDraft!.updatedAt);
        assert.equal(job.mode,'prepare');
        assert.equal(job.payload!.completeness!.requirement,'supplied');
        assert.equal(job.payload!.completeness!.source,'attorney_policy');
        assert.equal(job.payload!.completeness!.reason,null);
        assert.ok(f.db.getDraftDetail(f.draftId)!.caseDraft!.reviewedAt);
        assert.equal(f.db.listFilingJobs(f.draftId).length,1);
    } finally { f.close(); }
});

for(const operation of ['replace','remove'] as const) {
for(const requirement of ['demand','none'] as const) {
test(`${operation} supporting PDF invalidates its snapshot and approval without reviving a legacy ${requirement} gate`,()=>{
    const f=fixture();
    try {
        const deed=f.add('Ancillary document','Deed.pdf','uploaded',{pdf:deedPdf,recognition:deedRecognition});
        const original=f.db.getDraftDetail(f.draftId)!.documents.find(item=>item.id===f.ancillary)!;
        const before=f.db.updateCaseDraft(f.draftId,{
            supportingRequirement:requirement,
            supportingRequirementReason:'Attorney reviewed the synthetic PDFs and confirmed this supporting-document requirement.',
        },undefined,undefined,[
            {id:f.ancillary,filingType:'Other',filingRelation:'separate',supportingKind:'demand',supportingKindReviewed:true,
                expectedSourceVersion:original.sourceVersion,expectedContentHash:original.recognition!.contentHash},
            {id:deed,filingType:'Other',filingRelation:'separate'},
        ]);
        assert.deepEqual(before.caseDraft!.validationIssues,[]);
        assert.equal(before.caseDraft!.packageCompleteness.source,'attorney_policy');
        assert.equal(before.caseDraft!.packageCompleteness.reviewStale,false);
        assert.deepEqual(before.documents.find(item=>item.id===f.ancillary)!.supportingEvidence,{
            kind:'demand',source:'manual',contentHash:demandRecognition.contentHash,
        });
        const contextHash=before.caseDraft!.packageCompleteness.contextHash;
        const oldPayload=f.db.buildFilingPayload(f.draftId);
        f.db.reviewCaseDraft(f.draftId,'approve');
        assert.ok(f.db.getDraftDetail(f.draftId)!.caseDraft!.reviewedAt);
        if(operation==='replace') {
            const reservation=f.db.beginDocumentReplacement(f.ancillary);
            const processing=f.db.getDraftDetail(f.draftId)!.caseDraft!;
            assert.ok(processing.packageCompleteness.issues.length);
            assert.equal(processing.reviewedAt,null);
            const replaced=f.db.recordDocumentReplacement(f.ancillary,{token:reservation.token,fileSize:deedPdf.length});
            const unrecognized=replaced.documents.find(item=>item.id===f.ancillary)!;
            assert.equal(unrecognized.recognition,null);
            assert.deepEqual(unrecognized.supportingEvidence,{kind:'unknown',source:'unknown',contentHash:null});
            assert.ok(replaced.caseDraft!.packageCompleteness.issues.length);
            f.db.recordDocumentRecognition(f.ancillary,deedRecognition);
            const remapped=f.db.updateCaseDraft(f.draftId,{},undefined,undefined,[{
                id:f.ancillary,filingType:'Other',filingTypeReviewed:true,filingRelation:'separate',
            }]);
            assert.deepEqual(remapped.documents.find(item=>item.id===f.ancillary)!.supportingEvidence,{
                kind:'deed',source:'content',contentHash:deedRecognition.contentHash,
            },'the old manual Demand confirmation cannot apply to replacement deed bytes');
        } else {
            const removed=f.db.removeDraftDocument(f.draftId,f.ancillary);
            assert.ok(!removed.documents.some(item=>item.id===f.ancillary));
            assert.equal(f.db.getDocumentAccess(f.ancillary),null);
        }
        const after=f.db.refreshCaseDraftValidation(f.draftId);
        assert.equal(after.documents.length,operation==='replace'?7:6);
        assert.ok(!after.documents.some(item=>item.supportingEvidence?.kind==='demand'));
        assert.notEqual(after.caseDraft!.packageCompleteness.contextHash,contextHash);
        assert.equal(after.caseDraft!.packageCompleteness.reviewStale,false);
        assert.equal(after.caseDraft!.reviewedAt,null);
        assert.deepEqual(after.caseDraft!.validationIssues,[]);
        const newPayload=f.db.buildFilingPayload(f.draftId);
        assert.equal(validCompletenessSnapshot({...newPayload,completeness:oldPayload.completeness}),false);
        assert.equal(validCompletenessSnapshot(newPayload),true);
        assert.throws(()=>f.db.queueFilingJob(f.draftId),/Approve the Draft/);
        assert.equal(f.db.queueValidatedIntakes(),0);
        assert.equal(f.db.listFilingJobs(f.draftId).length,0);
    } finally { f.close(); }
});
}
}

test('automatic extraction deduplicates work and merges into manual leaf edits made while it runs',async()=>{
    const f=fixture();
    try {
        let release!:()=>void;
        const gate=new Promise<void>(resolve=>{release=resolve;});
        let calls=0;
        const extract=async():Promise<ComplaintExtractionResult>=>{calls++;await gate;return {...structuredClone(extraction),extractorVersion:CURRENT_COMPLAINT_EXTRACTOR_VERSION};};
        const pending=ensureDraftComplaintExtraction(f.db,f.draftId,{content:Buffer.from('mock'),extract});
        const duplicate=ensureDraftComplaintExtraction(f.db,f.draftId,{content:Buffer.from('mock'),extract});
        const filing=structuredClone(f.db.getDraftDetail(f.draftId)!.caseDraft!.filingData);
        filing.plaintiff!.phone='248-555-0101';
        filing.defendants[0].middleName=null;
        f.db.updateCaseDraft(f.draftId,{},undefined,filing);
        release();await Promise.all([pending,duplicate]);
        assert.equal(calls,1);
        assert.equal(f.db.getDraftDetail(f.draftId)!.caseDraft!.filingData.plaintiff!.phone,'248-555-0101');
        assert.equal(f.db.listPendingComplaintExtractions(CURRENT_COMPLAINT_EXTRACTOR_VERSION).length,0);
        const newer=structuredClone(extraction);newer.data.plaintiff!.city='Updated City';newer.data.plaintiff!.phone='999-555-0101';
        f.db.applyComplaintExtraction(f.draftId,f.complaint,{...newer,extractorVersion:CURRENT_COMPLAINT_EXTRACTOR_VERSION});
        const final=f.db.getDraftDetail(f.draftId)!.caseDraft!;
        assert.equal(final.filingData.plaintiff!.city,'Updated City');
        assert.equal(final.filingData.plaintiff!.phone,'248-555-0101');
    } finally {f.close();}
});

test('manual blank values and party-list changes remain protected on automatic re-extraction',()=>{
    const f=fixture();
    try {
        const filing=structuredClone(f.db.getDraftDetail(f.draftId)!.caseDraft!.filingData);
        filing.plaintiff!.address1=null;
        filing.defendants=[];
        f.db.updateCaseDraft(f.draftId,{},undefined,filing);
        f.db.applyComplaintExtraction(f.draftId,f.complaint,extraction);
        const final=f.db.getDraftDetail(f.draftId)!.caseDraft!;
        assert.equal(final.filingData.plaintiff!.address1,null);
        assert.deepEqual(final.filingData.defendants,[]);
        assert.ok(final.validationIssues.some(issue=>issue.field==='filingData.plaintiff.address1'));
    } finally {f.close();}
});

test('automatic failures back off persistently without changing successful PDF download status',async()=>{
    const f=fixture();
    try {
        let calls=0;
        const options={content:Buffer.from('mock'),extract:async()=>{calls++;throw new Error('Simulated extraction error');}};
        await ensureDraftComplaintExtraction(f.db,f.draftId,options);
        await ensureDraftComplaintExtraction(f.db,f.draftId,options);
        assert.equal(calls,1);
        assert.equal(f.db.listPendingComplaintExtractions(CURRENT_COMPLAINT_EXTRACTOR_VERSION).length,0);
        assert.equal(f.db.getDraftDetail(f.draftId)!.documents.find(doc=>doc.id===f.complaint)!.status,'uploaded');
        assert.match(f.db.getDraftDetail(f.draftId)!.caseDraft!.normalizedDataJson!,/nextRetryAt/);
    }finally{f.close();}
});

test('interrupted extraction is recovered and preparation cannot race a running extraction',async()=>{
    const f=fixture();
    try {
        f.db.updateCaseDraft(f.draftId,{},undefined,undefined,[{id:f.ancillary,filingType:'Other',filingRelation:'separate'}]);
        f.db.applyComplaintExtraction(f.draftId,f.complaint,{...extraction,extractorVersion:CURRENT_COMPLAINT_EXTRACTOR_VERSION});
        f.db.setComplaintAutoExtractionState(f.draftId,{documentId:f.complaint,sourceVersion:f.db.getComplaintSourceVersion(f.complaint),
            extractorVersion:CURRENT_COMPLAINT_EXTRACTOR_VERSION,status:'running',attempts:1});
        assert.throws(()=>f.db.queueFilingJob(f.draftId,'prepare','admin','admin',true),/still running/);
        assert.equal(f.db.listFilingJobs(f.draftId).length,0);
        assert.equal(f.db.recoverInterruptedComplaintExtractions(),1);
        assert.ok(f.db.listPendingComplaintExtractions(4).includes(f.draftId));
        await ensureDraftComplaintExtraction(f.db,f.draftId,{content:Buffer.from('mock'),extract:async()=>({...extraction,extractorVersion:CURRENT_COMPLAINT_EXTRACTOR_VERSION})});
        assert.ok(!JSON.parse(f.db.getDraftDetail(f.draftId)!.caseDraft!.normalizedDataJson!).complaintExtractionError);
    }finally{f.close();}
});

test('rejecting a Draft while reading is in flight cannot reopen it or restore approval',async()=>{
    for (const failing of [false,true]) {
    const f=fixture();
    try {
        let release!:()=>void;const gate=new Promise<void>(resolve=>{release=resolve;});
        const pending=ensureDraftComplaintExtraction(f.db,f.draftId,{content:Buffer.from('mock'),extract:async()=>{
            await gate;if(failing) throw new Error('Interrupted read failed');return {...extraction,extractorVersion:CURRENT_COMPLAINT_EXTRACTOR_VERSION};
        }});
        f.db.reviewCaseDraft(f.draftId,'reject');
        release();await pending;
        assert.equal(f.db.getDraftDetail(f.draftId)!.caseDraft!.status,'rejected');
        assert.equal(JSON.parse(f.db.getDraftDetail(f.draftId)!.caseDraft!.normalizedDataJson!).complaintAutoExtraction,undefined);
    }finally{f.close();}
    }
});

test('old extraction versions wait for automatic upgrade before automatic MiFILE preparation',async()=>{
    const f=fixture();
    try {
        f.db.saveCourtFilingRule({courtName:court,relation:'separate',confirmed:true});
        f.db.applyCourtFilingRule(f.draftId);
        f.db.refreshCaseDraftValidation(f.draftId);
        assert.deepEqual(f.db.getDraftDetail(f.draftId)!.caseDraft!.validationIssues,[]);
        assert.equal(f.db.queueValidatedIntakes(),0);
        await ensureDraftComplaintExtraction(f.db,f.draftId,{content:Buffer.from('mock'),extract:async()=>({...extraction,extractorVersion:CURRENT_COMPLAINT_EXTRACTOR_VERSION})});
        assert.equal(f.db.queueValidatedIntakes(),1);
    }finally{f.close();}
});

test('a replacement invalidates an extraction in flight, then automatically reads the new PDF',async()=>{
    const f=fixture();
    try {
        let release!:()=>void;
        const gate=new Promise<void>(resolve=>{release=resolve;});
        const pending=ensureDraftComplaintExtraction(f.db,f.draftId,{content:Buffer.from('old'),extract:async()=>{
            await gate;return {...structuredClone(extraction),extractorVersion:CURRENT_COMPLAINT_EXTRACTOR_VERSION};
        }});
        const reservation=f.db.beginDocumentReplacement(f.complaint);
        f.db.recordDocumentReplacement(f.complaint,{token:reservation.token,fileSize:123,mimeType:'application/pdf'});
        const newer=structuredClone(extraction);newer.data.plaintiff!.entityName='New Owner LLC';newer.data.plaintiff!.displayName='New Owner LLC';
        const replacement=ensureDraftComplaintExtraction(f.db,f.draftId,{content:Buffer.from('new'),extract:async()=>({...newer,extractorVersion:CURRENT_COMPLAINT_EXTRACTOR_VERSION})});
        release();await pending;await replacement;
        assert.equal(f.db.getDraftDetail(f.draftId)!.caseDraft!.filingData.plaintiff!.entityName,'New Owner LLC');
    }finally{f.close();}
});

test('automatic court and title values refresh, but manually corrected or cleared identifiers remain protected',()=>{
    const f=fixture(null);
    try {
        const before=f.db.getDraftDetail(f.draftId)!.caseDraft!;
        assert.equal(before.fieldSources.courtName,'complaint');
        const newer=structuredClone(extraction);newer.data.courtDistrict='29';
        f.db.applyComplaintExtraction(f.draftId,f.complaint,newer);
        assert.match(f.db.getDraftDetail(f.draftId)!.caseDraft!.editableData.courtName!,/29th/);
        f.db.updateCaseDraft(f.draftId,{courtName:null,caseTitle:'Manual case title'});
        f.db.applyComplaintExtraction(f.draftId,f.complaint,extraction);
        assert.equal(f.db.getDraftDetail(f.draftId)!.caseDraft!.editableData.courtName,null);
        assert.equal(f.db.getDraftDetail(f.draftId)!.caseDraft!.editableData.caseTitle,'Manual case title');
    }finally{f.close();}
});

test('saving unchanged document controls does not freeze automatic Complaint Filing Types',()=>{
    const f=fixture();
    try {
        const doc=f.db.getDraftDetail(f.draftId)!.documents.find(doc=>doc.id===f.complaint)!;
        f.db.updateCaseDraft(f.draftId,{},undefined,undefined,[{id:doc.id,filingType:doc.filingType,
            filingTypeReviewed:false,filingRelation:doc.filingRelation,filingRelationReviewed:false}]);
        const newer=structuredClone(extraction);newer.data.moneyJudgmentRequested=true;newer.data.claimAmount='1200.00';
        f.db.applyComplaintExtraction(f.draftId,f.complaint,newer);
        assert.match(f.db.getDraftDetail(f.draftId)!.documents.find(item=>item.id===doc.id)!.filingType!,/Supplemental Money Judgment/);
        f.db.updateCaseDraft(f.draftId,{},undefined,undefined,[{id:doc.id,filingType:'Complaint for Possession Only',filingTypeReviewed:true}]);
        f.db.applyComplaintExtraction(f.draftId,f.complaint,newer);
        assert.equal(f.db.getDraftDetail(f.draftId)!.documents.find(item=>item.id===doc.id)!.filingType,'Complaint for Possession Only');
    }finally{f.close();}
});

test('legacy failures after creating a case form require reconciliation on migration',()=>{
    const f=fixture();
    const filename=f.db.getPath();
    let reopened:WorkflowDatabase|undefined;
    try {
        f.db.updateCaseDraft(f.draftId,{},undefined,undefined,[{id:f.ancillary,filingRelation:'separate',filingType:'Other'}]);
        f.db.reviewCaseDraft(f.draftId,'approve');
        const job=f.db.queueFilingJob(f.draftId);
        f.db.claimNextFilingJob();
        f.db.completeFilingJob({filingJobId:job.id,status:'failed',checkpoint:'document_upload',errorCode:'FILING_TYPE_NOT_AVAILABLE',errorMessage:'Missing exact label'});
        f.db.close();
        const raw=new DatabaseSync(filename);
        raw.prepare('DELETE FROM schema_migrations WHERE version = 26').run();
        raw.close();
        reopened=new WorkflowDatabase(filename);
        assert.equal(reopened.getFilingJob(job.id)!.status,'reconciliation_required');
        assert.match(reopened.getFilingJob(job.id)!.errorMessage!,/Missing exact label.*partial bundle/);
        assert.equal(reopened.getDraftDetail(f.draftId)!.caseDraft!.status,'filing_reconciliation');
        assert.throws(()=>reopened!.queueFilingJob(f.draftId),/Approve the Draft/);
        assert.equal(reopened.listFilingJobs(f.draftId).length,1);
    } finally {
        reopened?.close();
        fs.rmSync(path.dirname(filename),{recursive:true,force:true});
    }
});

test('a restart after saving the case form blocks another preparation until reconciliation',()=>{
    const f=fixture();
    try {
        f.db.updateCaseDraft(f.draftId,{},undefined,undefined,[{id:f.ancillary,filingRelation:'separate',filingType:'Other'}]);
        f.db.reviewCaseDraft(f.draftId,'approve');
        const job=f.db.queueFilingJob(f.draftId);
        f.db.claimNextFilingJob();
        f.db.appendFilingJobLog(job.id,{level:'info',checkpoint:'case_form',message:'Case form saved.'});
        assert.equal(f.db.recoverInterruptedFilingJobs(),1);
        assert.equal(f.db.getFilingJob(job.id)!.status,'reconciliation_required');
        assert.throws(()=>f.db.queueFilingJob(f.draftId),/Approve the Draft/);
    }finally{f.close();}
});

test('removing a duplicate PDF preserves OneDrive, cancels retries and does not resurrect it on email reprocessing',async()=>{
    const f=fixture();
    try{
        const duplicate=f.add('Complaint','Duplicate Complaint.pdf');
        const before=f.db.getDraftDetail(f.draftId)!;
        f.parsed.filedDocuments=before.documents.map(doc=>({documentName:doc.originalFilename!,documentType:doc.documentType!,
            status:'Received',comments:null,downloadUrl:doc.sourceUrl}));
        assert.ok(before.caseDraft!.validationIssues.some(issue=>/exactly one/.test(issue.message)));
        const removed=f.db.removeDraftDocument(f.draftId,duplicate);
        assert.equal(removed.documents.length,6);
        assert.ok(!removed.documents.some(doc=>doc.id===duplicate));
        assert.equal(f.db.getDocumentAccess(duplicate),null);
        assert.throws(()=>f.db.queueDocumentRetry(duplicate),/not found/);
        const audit=removed.auditLogs.find(log=>log.action==='draft_document_removed')!;
        assert.equal(JSON.parse(audit.metadataJson!).oneDriveFilePreserved,'https://onedrive.example/Duplicate%20Complaint.pdf');
        f.db.createCaseDraft(f.email.id,f.parsed);
        let downloads=0;
        await processFilingIntake(f.db,f.email.id,f.draftId,f.parsed,{download:async()=>{downloads++;throw new Error('Must not redownload');},extract:async()=>extraction});
        assert.equal(downloads,0);
        assert.equal(f.db.getDraftDetail(f.draftId)!.documents.length,6);
        assert.equal(JSON.parse(f.db.getDraftDetail(f.draftId)!.caseDraft!.normalizedDataJson || '{}').manualDocumentEdits,true);
    }finally{f.close();}
});

test('removing the Complaint clears automatic facts and source selection but preserves explicit manual corrections',()=>{
    const f=fixture();
    try{
        const data=f.db.getDraftDetail(f.draftId)!.caseDraft!.filingData;
        f.db.updateCaseDraft(f.draftId,{},undefined,{...data,plaintiff:{...data.plaintiff,address1:'Attorney-confirmed address'}});
        const removed=f.db.removeDraftDocument(f.draftId,f.complaint).caseDraft!;
        assert.equal(removed.primaryDocumentId,null);
        assert.equal(removed.complaintExtraction,null);
        assert.equal(removed.filingData.plaintiff.address1,'Attorney-confirmed address');
        assert.deepEqual(removed.filingData.defendants,[]);
        assert.equal(removed.filingData.moneyJudgmentRequested,null);
        assert.ok(removed.validationIssues.some(issue=>issue.field==='primaryDocumentId'));
        assert.equal(f.db.queueValidatedIntakes(),0);
    }finally{f.close();}
});

test('removing the only failed attachment does not recreate a new pending copy on inbox sync',()=>{
    const directory=fs.mkdtempSync(path.join(os.tmpdir(),'removed-failed-pdf-'));
    const db=new WorkflowDatabase(path.join(directory,'workflow.sqlite'));
    try{
        const message={id:'one-failed-attachment',subject:'NEW LT FILING - Failed PDF'};
        const parsed=buildFilingIntake(message,[{id:'attachment',name:'Complaint.pdf',contentType:'application/pdf',isInline:false,size:200}]);
        const email=db.registerEmail(message);
        const draft=db.createCaseDraft(email.id,parsed);
        const document=db.getDraftDetail(draft)!.documents[0];
        db.completeDocumentRetryFailure({documentId:document.id,reason:'Invalid original PDF',downloadAttempts:3});
        db.removeDraftDocument(draft,document.id);
        db.createCaseDraft(email.id,parsed);
        assert.equal(db.getDraftDetail(draft)!.documents.length,0);
        assert.equal(db.claimDueDocumentRetries(50).length,0);
    }finally{db.close();fs.rmSync(directory,{recursive:true,force:true});}
});

test('a failed PDF can be replaced in place; an interrupted replacement never downloads the old source again',()=>{
    const f=fixture();
    try{
        const document=f.add('Other','Failed Other.pdf','failed');
        const first=f.db.beginDocumentReplacement(document);
        assert.equal(f.db.getDraftDetail(f.draftId)!.documents.find(doc=>doc.id===document)!.sourceUrl,null);
        assert.throws(()=>f.db.beginDocumentReplacement(document),/processing/);
        assert.throws(()=>f.db.removeDraftDocument(f.draftId,document),/processing/);
        assert.equal(f.db.recoverInterruptedDocumentRetries(),1);
        let failed=f.db.getDraftDetail(f.draftId)!.documents.find(doc=>doc.id===document)!;
        assert.equal(failed.status,'failed');
        assert.equal(failed.nextRetryAt,null);
        assert.match(failed.errorMessage!,/replacement was interrupted/);
        assert.ok(!f.db.claimDueDocumentRetries(50).some(retry=>retry.documentId===document));
        const retry=f.db.beginDocumentReplacement(document);
        assert.throws(()=>f.db.recordDocumentReplacement(document,{fileSize:200,token:first.token}),/no longer current/);
        f.db.failDocumentReplacement(document,retry.token,new Error('OneDrive unavailable'));
        failed=f.db.getDraftDetail(f.draftId)!.documents.find(doc=>doc.id===document)!;
        assert.equal(failed.nextRetryAt,null);
        assert.match(failed.errorMessage!,/OneDrive unavailable/);
        const final=f.db.beginDocumentReplacement(document);
        f.db.recordDocumentReplacement(document,{fileSize:300,token:final.token,oneDriveUrl:'https://onedrive.example/corrected',currentFilename:'Corrected.pdf'});
        const repaired=f.db.getDraftDetail(f.draftId)!.documents.find(doc=>doc.id===document)!;
        assert.equal(repaired.status,'replaced');assert.equal(repaired.oneDriveUrl,'https://onedrive.example/corrected');
        assert.equal(repaired.sourceUrl,null);assert.equal(repaired.nextRetryAt,null);
        assert.equal(f.db.getDraftDetail(f.draftId)!.documents.length,7);
    }finally{f.close();}
});

test('re-extracting a replacement Complaint refreshes old automatic parties rather than treating them as manual edits',()=>{
    const f=fixture();
    try{
        const reservation=f.db.beginDocumentReplacement(f.complaint);
        assert.equal(f.db.getDraftDetail(f.draftId)!.caseDraft!.filingData.defendants.length,0);
        f.db.recordDocumentReplacement(f.complaint,{fileSize:300,token:reservation.token});
        f.db.recordDocumentRecognition(f.complaint,recognizeDocumentText(['COMPLAINT'],'Complaint.pdf'));
        const changed:ComplaintExtractionResult={...extraction,textHash:'qa-v2',data:{...extraction.data,
            defendants:[{...extraction.data.defendants![0],displayName:'Taylor Resident',firstName:'Taylor',lastName:'Resident'}],
            moneyJudgmentRequested:true,claimAmount:'1500.00'}};
        const after=f.db.applyComplaintExtraction(f.draftId,f.complaint,changed).caseDraft!;
        assert.equal(after.filingData.defendants[0].firstName,'Taylor');
        assert.equal(after.editableData.defendant,'Taylor Resident');
        assert.equal(after.filingData.claimAmount,'1500.00');
        assert.equal(after.filingFieldSources.defendants,'complaint');
        assert.equal(f.db.queueValidatedIntakes(),0);
    }finally{f.close();}
});

test('manual document edits require confirmation and cannot be picked up by automatic preparation',()=>{
    const f=fixture();
    try{
        f.db.updateCaseDraft(f.draftId,{},undefined,undefined,[{id:f.ancillary,filingType:'Other',filingRelation:'separate'}]);
        const duplicate=f.add('Complaint','Duplicate.pdf');
        const corrected=f.db.removeDraftDocument(f.draftId,duplicate);
        assert.deepEqual(corrected.caseDraft!.validationIssues,[]);
        assert.equal(corrected.caseDraft!.status,'ready_to_file');
        assert.equal(f.db.queueValidatedIntakes(),0);
        assert.throws(()=>f.db.queueFilingJob(f.draftId),/Approve the Draft/);
        f.db.reviewCaseDraft(f.draftId,'approve');
        assert.equal(f.db.queueFilingJob(f.draftId).payload!.documents.length,6);
    }finally{f.close();}
});

test('reprocessing an email never restores the old source over a failed manual replacement',async()=>{
    const f=fixture();
    try{
        const failed=f.add('Other','Failed Source.pdf','failed');
        f.parsed.filedDocuments=[{documentName:'Failed Source.pdf',documentType:'Other',status:'Received',comments:null,
            downloadUrl:f.db.getDraftDetail(f.draftId)!.documents.find(doc=>doc.id===failed)!.sourceUrl}];
        const reservation=f.db.beginDocumentReplacement(failed);
        f.db.failDocumentReplacement(failed,reservation.token,'OneDrive unavailable');
        f.db.createCaseDraft(f.email.id,f.parsed);
        let downloads=0;
        await processFilingIntake(f.db,f.email.id,f.draftId,f.parsed,{download:async()=>{downloads++;throw new Error('Retired source must not be retried');},extract:async()=>extraction});
        assert.equal(downloads,0);
        assert.equal(f.db.getDraftDetail(f.draftId)!.documents.find(doc=>doc.id===failed)!.sourceUrl,null);
    }finally{f.close();}
});

test('locked Drafts and court notifications cannot change or remove their documents',()=>{
    const f=fixture();
    try{
        f.db.setCaseDraftStatus(f.draftId,'filing_prepared','passed','prepared');
        assert.throws(()=>f.db.removeDraftDocument(f.draftId,f.complaint),/locked/);
        assert.throws(()=>f.db.beginDocumentReplacement(f.complaint),/locked/);
        assert.throws(()=>f.db.recordDocumentReplacement(f.complaint,{fileSize:100}),/locked/);
        assert.equal(f.db.getDraftDetail(f.draftId)!.documents.length,6);
        const message={id:'court-notification',subject:'MiFILE - Document Filed 26-00001-LT',from:{emailAddress:{address:'info@truefiling.com'}}};
        const email=f.db.registerEmail(message);
        const draft=f.db.createCaseDraft(email.id,{...buildFilingIntake(message,[]),sourceKind:undefined,isMiFile:true});
        const doc=f.db.addDocument({emailId:email.id,caseDraftId:draft,currentFilename:'Filed.pdf',status:'uploaded',uploadSource:'email',oneDriveUrl:'https://onedrive.example/filed'});
        assert.throws(()=>f.db.beginDocumentReplacement(doc),/Only new filing/);
        assert.throws(()=>f.db.removeDraftDocument(draft,doc),/Only new filing/);
        const copiedEmail=f.db.registerEmail({id:'legacy-copied-notification',subject:message.subject});
        const copiedDraft=f.db.createCaseDraft(copiedEmail.id,{...buildFilingIntake(message,[]),isMiFile:true});
        const copiedDoc=f.db.addDocument({emailId:copiedEmail.id,caseDraftId:copiedDraft,currentFilename:'Legacy Copy.pdf',
            status:'uploaded',uploadSource:'email',oneDriveUrl:'https://onedrive.example/legacy-copy'});
        assert.throws(()=>f.db.beginDocumentReplacement(copiedDoc),/Court notifications/);
        assert.throws(()=>f.db.removeDraftDocument(copiedDraft,copiedDoc),/Court notifications/);
    }finally{f.close();}
});

test('court rules require confirmation and exact courts, retain versions, and preserve explicit manual document choices',()=>{
    const f=fixture();
    try{
        assert.throws(()=>f.db.saveCourtFilingRule({courtName:court,relation:'separate',confirmed:false}),/Confirm/);
        assert.throws(()=>f.db.saveCourtFilingRule({courtName:court,relation:'separate',confirmed:'false' as any}),/Confirm/);
        assert.throws(()=>f.db.saveCourtFilingRule({courtName:'25',relation:'separate',confirmed:true}),/exact court/);
        const first=f.db.saveCourtFilingRule({courtName:court,relation:'connected_to_complaint',confirmed:true});
        let detail=f.db.applyCourtFilingRule(f.draftId);
        let document=detail.documents.find(doc=>doc.id===f.ancillary)!;
        assert.equal(document.filingRelation,'connected_to_complaint');
        assert.equal(document.filingRelationSource,'court_rule');
        assert.equal(document.courtRule!.id,first.id);
        f.db.updateCaseDraft(f.draftId,{},undefined,undefined,[{id:document.id,filingRelation:document.filingRelation,filingType:'Other'}]);
        assert.equal(f.db.getDraftDetail(f.draftId)!.documents.find(doc=>doc.id===document.id)!.filingRelationSource,'court_rule');
        const second=f.db.saveCourtFilingRule({courtName:court,relation:'separate',notes:'Confirmed by attorney',confirmed:true,expectedId:first.id});
        assert.equal(f.db.listCourtFilingRules(true).length,2);
        detail=f.db.applyCourtFilingRule(f.draftId);
        assert.equal(detail.documents.find(doc=>doc.id===document.id)!.courtRule!.id,first.id);
        assert.ok(detail.caseDraft!.validationIssues.some(issue=>/rule used.*changed/.test(issue.message)));
        detail=f.db.applyCourtFilingRule(f.draftId,true);
        document=detail.documents.find(doc=>doc.id===document.id)!;
        assert.equal(document.filingRelation,'separate');assert.equal(document.courtRule!.id,second.id);
        f.db.updateCaseDraft(f.draftId,{},undefined,undefined,[{id:document.id,filingRelation:'separate',filingType:'Other',filingRelationReviewed:true}]);
        f.db.saveCourtFilingRule({courtName:court,relation:'connected_to_complaint',confirmed:true});
        document=f.db.applyCourtFilingRule(f.draftId,true).documents.find(doc=>doc.id===document.id)!;
        assert.equal(document.filingRelation,'separate');assert.equal(document.filingRelationSource,'manual');
        assert.throws(()=>f.db.saveCourtFilingRule({courtName:court,relation:'manual_review',confirmed:true,expectedId:first.id}),/changed/);
    }finally{f.close();}
});

test('the intake pipeline applies a confirmed court rule before automatically queueing a complete package',async()=>{
    const f=fixture();
    try{
        f.db.applyComplaintExtraction(f.draftId,f.complaint,{...extraction,extractorVersion:CURRENT_COMPLAINT_EXTRACTOR_VERSION});
        f.db.saveCourtFilingRule({courtName:court,relation:'connected_to_complaint',confirmed:true});
        const detail=await processFilingIntake(f.db,f.email.id,f.draftId,f.parsed,{download:async()=>{throw new Error('No files need downloading');},extract:async()=>extraction});
        assert.equal(detail.documents.find(doc=>doc.id===f.ancillary)!.filingRelationSource,'court_rule');
        assert.deepEqual(detail.caseDraft!.validationIssues,[]);
        assert.equal(f.db.queueValidatedIntakes(),1);
        assert.equal(f.db.listFilingJobs(f.draftId)[0].payload!.documents.find(doc=>doc.id===f.ancillary)!.filingRelation,'connected_to_complaint');
    }finally{f.close();}
});

test('a court change clears the old automatic rule; Manual review and disabled rules block preparation',()=>{
    const f=fixture();
    try{
        const rule=f.db.saveCourtFilingRule({courtName:court,relation:'separate',confirmed:true});
        f.db.applyCourtFilingRule(f.draftId);
        f.db.updateCaseDraft(f.draftId,{courtName:otherCourt},undefined,{...f.db.getDraftDetail(f.draftId)!.caseDraft!.filingData,courtDistrict:'29'});
        let document=f.db.applyCourtFilingRule(f.draftId).documents.find(doc=>doc.id===f.ancillary)!;
        assert.equal(document.filingRelation,'separate');assert.equal(document.courtRule?.courtKey,f.db.listCourtFilingRules().find(r=>r.courtName===otherCourt)?.courtKey);
        const manual=f.db.saveCourtFilingRule({courtName:otherCourt,relation:'manual_review',notes:'Court-specific exceptions must be reviewed',confirmed:true});
        document=f.db.applyCourtFilingRule(f.draftId,true).documents.find(doc=>doc.id===f.ancillary)!;
        assert.equal(document.filingRelation,'unknown');
        assert.throws(()=>f.db.reviewCaseDraft(f.draftId,'approve'),/Choose whether/);
        f.db.disableCourtFilingRule(manual.id);
        assert.ok(f.db.getDraftDetail(f.draftId)!.caseDraft!.validationIssues.some(issue=>/disabled/.test(issue.message)));
        assert.equal(f.db.listCourtFilingRules().length,1);
        assert.equal(f.db.listCourtFilingRules()[0].id,rule.id);
    }finally{f.close();}
});
