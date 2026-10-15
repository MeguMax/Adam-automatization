import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { WorkflowDatabase } from './database';
import { buildFilingIntake } from './filingIntake';
import { processFilingIntake } from './filingIntakeWorker';
import { recognizeDocumentText } from './documentRecognition';
import type { ComplaintExtractionResult } from './complaintExtractor';

const court = 'MI Example County - 25th District Court';
const otherCourt = 'MI Example County - 29th District Court';
const extraction: ComplaintExtractionResult = {
    extractorVersion:3,extractionMethod:'form_fields',formType:'NONPAYMENT OF RENT',pageCount:1,textHash:'qa-v1',
    data:{courtDistrict:'25',relatedCivilAction:'none',moneyJudgmentRequested:false,claimAmount:'0.00',mailingRequested:true,
        plaintiff:{displayName:'Example Owner LLC',entityName:'Example Owner LLC',address1:'100 Main Street',city:'Lincoln Park',state:'MI',postalCode:'48146'},
        defendants:[{displayName:'Morgan Tenant',firstName:'Morgan',lastName:'Tenant',address1:'200 Main Street',city:'Lincoln Park',state:'MI',postalCode:'48146'}]},
    fieldConfidence:{},warnings:[],
};

function fixture() {
    const directory=fs.mkdtempSync(path.join(os.tmpdir(),'draft-documents-'));
    const db=new WorkflowDatabase(path.join(directory,'workflow.sqlite'));
    const message={id:'qa-package',subject:'NEW LT FILING - Example',from:{emailAddress:{address:'qa@example.com'}}};
    const parsed={...buildFilingIntake(message,[]),courtName:court};
    const email=db.registerEmail(message);
    const draftId=db.createCaseDraft(email.id,parsed);
    const add=(type:string,name=type+'.pdf',status:'uploaded'|'failed'='uploaded')=>db.addDocument({
        emailId:email.id,caseDraftId:draftId,originalFilename:name,currentFilename:name,documentType:type,
        status,uploadSource:'email_intake',sourceUrl:'email-attachment://qa/'+encodeURIComponent(name),
        oneDriveUrl:status==='uploaded'?'https://onedrive.example/'+encodeURIComponent(name):null,
    });
    const complaint=add('Complaint');
    for(const role of ['Advice','Local','Summons','Request'])add(role);
    const ancillary=add('Ancillary document','Demand.pdf');
    db.applyComplaintExtraction(draftId,complaint,extraction);
    db.markEmailProcessed(email.id);
    return {db,parsed,email,draftId,complaint,ancillary,add,close(){db.close();fs.rmSync(directory,{recursive:true,force:true});}};
}

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
        assert.equal(document.filingRelation,'unknown');assert.equal(document.courtRule,null);
        const manual=f.db.saveCourtFilingRule({courtName:otherCourt,relation:'manual_review',notes:'Court-specific exceptions must be reviewed',confirmed:true});
        document=f.db.applyCourtFilingRule(f.draftId).documents.find(doc=>doc.id===f.ancillary)!;
        assert.equal(document.filingRelation,'unknown');
        assert.throws(()=>f.db.reviewCaseDraft(f.draftId,'approve'),/Choose whether/);
        f.db.disableCourtFilingRule(manual.id);
        assert.ok(f.db.getDraftDetail(f.draftId)!.caseDraft!.validationIssues.some(issue=>/disabled/.test(issue.message)));
        assert.equal(f.db.listCourtFilingRules().length,1);
        assert.equal(f.db.listCourtFilingRules()[0].id,rule.id);
    }finally{f.close();}
});
