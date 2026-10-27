import assert from 'node:assert/strict';
import test, {before,after} from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {chromium,type Browser} from 'playwright';
import {WorkflowDatabase,type FilingJobView,type FilingPayload} from './database';
import {preparationDigest} from './mifilePreparationEvidence';
import {buildCheckoutQuote,checkoutReviewIssues,digest,FINAL_MIFILE_ACTIONS_ENABLED,quoteDigest,
    receiptSummary,validateReceipt,type CheckoutAccount,type MiFileReceiptObservation} from './mifileCheckout';
import {parseMiFileReceiptFields,parseMiFileReceiptPdf} from './mifileReceipts';
import {testPdfFixture} from './testPdfFixture';

const directory=fs.mkdtempSync(path.join(os.tmpdir(),'checkout-qa-'));
const account:CheckoutAccount={username:'qa@example.com',identity:digest('revision-1'),accountEnvironment:'test',productionConfirmed:false};
const fees=[['Filing Fee','$90.00'],['eFiling System Fee','$20.00'],['Processing Service Fee *','$3.69'],['Additional Payment','$13.00'],['Total','$126.69']];
const method={state:'selected' as const,fingerprint:digest('opaque-payment-token')};
let browser:Browser;
before(async()=>{
    Object.assign(process.env,{TENANT_ID:'11111111-1111-1111-1111-111111111111',CLIENT_ID:'qa-client',CLIENT_SECRET:'qa-only',
        USER_EMAIL:'qa@example.com',ONEDRIVE_ROOT_SHARE_URL:'https://onedrive.example/root',WORKFLOW_DB_PATH:path.join(directory,'global.sqlite')});
    browser=await chromium.launch({headless:true});
});
after(async()=>{await browser?.close();require('./database').getWorkflowDatabase().close();fs.rmSync(directory,{recursive:true,force:true});});

function prepared():FilingJobView {
    const payload={documents:[{id:'doc-1',filingName:'Complaint.pdf',filingType:'Complaint for Possession Only',
        filingRelation:'separate',isPrimary:true}],courtName:'Court',subject:'NEW LT FILING - QA checkout'} as FilingPayload;
    const sources=[{documentId:'doc-1',sha256:'ab'.repeat(32),bytes:200}];
    const bundle='fd2c1ad4-633d-429a-0166-08df32c555de';
    return {id:'job-1',caseDraftId:'draft-1',status:'prepared',payload,externalBundleId:bundle,temporaryCaseNumber:'TEMP-QA',result:{
        url:'https://mifile.courts.michigan.gov/filing/create/'+bundle,
        documentManifest:[{documentId:'doc-1',filingName:'Complaint.pdf',filingType:'Complaint for Possession Only',filingRelation:'separate',parentDocumentId:null}],
        savedBundleEvidence:{version:1,verifiedAt:new Date().toISOString(),sourcePdfCount:1,generatedPdfCount:1,connectedPdfCount:0,
            courtName:'Court',externalBundleId:bundle,temporaryCaseNumber:'TEMP-QA',filer:'Devlin, Adam (P72877)',accountEmail:account.username,
            sources,packageDigest:preparationDigest(payload,sources)},
    }} as unknown as FilingJobView;
}
function quote(job=prepared(),now=Date.now()) {
    return buildCheckoutQuote(job,account,fees,method,(job.result!.savedBundleEvidence as any).packageDigest,10300,now);
}
function receipt(status:MiFileReceiptObservation['status']='Unsubmitted'):MiFileReceiptObservation {
    return {bundleId:prepared().externalBundleId!,accountEmail:account.username,kind:'bundle_status',externalReference:'test-reference',
        documentId:null,status,occurredAt:null,observedAt:new Date().toISOString(),totalCents:null,currency:null,receiptUrl:null,source:'mifile_history'};
}
function storeFixture() {
    const db=new WorkflowDatabase(path.join(directory,Math.random()+'.sqlite'));
    const sql=(db as any).db;
    const job=prepared();
    const email=db.registerEmail({id:'qa',subject:'NEW LT FILING - QA checkout'});
    const draftId=db.createCaseDraft(email.id,{isMiFile:false,fileTypeByAttachmentId:{},courtName:null,caseNumber:null,
        caseTitle:null,plaintiff:null,defendant:null,bundleNumber:null,filerName:null,filedAt:null,filedDocuments:[]});
    job.caseDraftId=draftId;
    sql.prepare(`INSERT INTO filing_jobs(id,case_draft_id,attempt_number,mode,status,created_at,updated_at)
        VALUES(?, ?, 1, 'prepare','prepared',?,?)`).run(job.id,draftId,new Date().toISOString(),new Date().toISOString());
    const {CheckoutStore}=require('./checkoutStore') as typeof import('./checkoutStore');
    const audit:Array<string>=[];
    return {db,sql,job,store:new CheckoutStore(sql,()=>job,(_id,action)=>{audit.push(action);}),audit,email};
}

test('live checkout fee fixture reconciles exact USD total, not pre-checkout subtotal',()=>{
    const job=prepared(), q=quote(job);
    assert.equal(q.totalCents,12669); assert.equal(q.processingFeeCents,369);
    assert.deepEqual(checkoutReviewIssues(q,job,account),[]);
    assert.equal(FINAL_MIFILE_ACTIONS_ENABLED,false);
    assert.equal(q.paymentAuthorized,false);assert.equal(q.courtSubmissionAuthorized,false);
});
test('zero conditional fees are allowed; ambiguous, changed, negative or unknown amounts are blocked',()=>{
    const job=prepared(), hash=(job.result!.savedBundleEvidence as any).packageDigest;
    assert.equal(buildCheckoutQuote(job,account,[['Total','$0.00']],{state:'missing',fingerprint:null},hash,0).paymentMethodState,'not_required');
    for(const rows of [[...fees,['Total','$126.69']], [...fees,['Unknown Fee','$1.00']], fees.map(row=>row[0]==='Total'?['Total','$126.70']:row),
        [['Filing Fee','-$1.00'],['Total','-$1.00']], [['Total','$126.6']], [['Filing Fee','$126.69'],['Total','$126.69']]]) {
        assert.throws(()=>buildCheckoutQuote(job,account,rows,method,hash,10300));
    }
    assert.throws(()=>buildCheckoutQuote(job,account,fees,method,digest('different PDF'),10300));
});
test('confirmation binds expiry, account credential revision, source package and selected method',()=>{
    const job=prepared(),now=Date.now(),q=quote(job,now);
    assert.ok(checkoutReviewIssues(q,job,account,now+900001).some(issue=>issue.includes('expired')));
    assert.ok(checkoutReviewIssues(q,job,{...account,identity:digest('revision-2')},now).some(issue=>issue.includes('account changed')));
    assert.ok(checkoutReviewIssues(q,{...job,payload:{...job.payload!,courtName:'Other court'}},account,now).length);
    const missing=buildCheckoutQuote(job,account,fees,{state:'missing',fingerprint:null},q.packageDigest,10300,now);
    assert.ok(checkoutReviewIssues(missing,job,account,now).some(issue=>issue.startsWith('Add a payment')));
    assert.throws(()=>buildCheckoutQuote(job,account,fees,{state:'selected',fingerprint:'4111111111111111'},q.packageDigest,10300));
    assert.ok(checkoutReviewIssues({...q,lines:[null]} as any,job,account).length);
    assert.ok(checkoutReviewIssues({...q,totalCents:1},job,account).length);
    assert.ok(checkoutReviewIssues({...q,paymentAuthorized:true} as any,job,account).length);
});
test('persistent amount review is exact, idempotent and invalidated by a newer failed check',()=>{
    const {db,store,job,audit}=storeFixture();
    try {
        const work=store.queue(job.id,'quote',account);assert.equal(store.queue(job.id,'quote',account).id,work.id);
        assert.equal(db.hasActiveFilingJobs(),true);assert.equal(store.claim()!.id,work.id);assert.equal(store.claim(),null);
        const q=quote(job); store.complete(work.id,{kind:'quote',quote:q},account);
        const input={quoteId:q.id,quoteDigest:q.quoteDigest,totalCents:q.totalCents};
        assert.throws(()=>store.confirm(job.id,{...input,totalCents:12668},account,'qa'));
        assert.throws(()=>store.confirm(job.id,{...input,quoteId:'old-quote'},account,'qa'));
        store.confirm(job.id,input,account,'qa');store.confirm(job.id,input,account,'qa');
        assert.ok(store.state(job.id,account).confirmedAt);assert.equal(audit.filter(action=>action==='checkout_amount_reviewed').length,1);
        const publicState=JSON.stringify(store.state(job.id,account));
        assert.ok(!publicState.includes(account.identity));assert.ok(!publicState.includes(method.fingerprint));
        const next=store.queue(job.id,'quote',account);store.claim();store.fail(next.id,'MiFILE unavailable');
        assert.equal(store.state(job.id,account).canConfirm,false);assert.equal(store.state(job.id,account).confirmedAt,null);
        assert.equal(store.state(job.id,account).paymentExecutionEnabled,false);
    } finally {db.close();}
});
test('interruption recovery and serialization do not alter Prepared or enable automatic payment retry',()=>{
    const {db,store,sql,job,email}=storeFixture();
    try {
        sql.prepare("UPDATE filing_jobs SET status='running'").run();
        const work=store.queue(job.id,'receipts',account);assert.equal(store.claim(),null);
        sql.prepare("UPDATE filing_jobs SET status='prepared'").run();store.claim();
        assert.equal(db.claimNextFilingJob(),null);assert.throws(()=>db.deleteEmailRecord(email.id));
        assert.equal(store.recover(),1);assert.equal(store.get(work.id)!.status,'failed');
        assert.equal(job.status,'prepared');assert.equal(store.state(job.id,account).receiptSummary.retryPaymentAllowed,false);
        sql.prepare('DELETE FROM filing_jobs WHERE id=?').run(job.id);
        assert.equal(store.get(work.id),null);
    } finally{db.close();}
});
test('receipt statuses distinguish payment processing from official filing and refunds',()=>{
    for(const status of ['Submitted','In Progress','Accepted','Paid'] as const) {
        assert.deepEqual(receiptSummary([{...receipt(status),documentId:'doc-1'}]).courtFiledDocumentIds,[]);
    }
    assert.equal(receiptSummary([receipt('Rejected')]).refundReported,false);
    assert.equal(receiptSummary([receipt('Unsubmitted')]).submissionObserved,false);
    const filed={...receipt('Filed'),documentId:'doc-1',occurredAt:'2026-10-27T10:00:00Z'};
    const rejected={...filed,status:'Rejected' as const,occurredAt:'2026-10-27T11:00:00Z'};
    assert.deepEqual(receiptSummary([rejected,filed]).courtFiledDocumentIds,[]);
    assert.deepEqual(receiptSummary([rejected,filed]).courtRejectedDocumentIds,['doc-1']);
});
test('strict receipt parsing requires exact bundle, transaction and amount; no guessed payment status',async()=>{
    const job=prepared(),fields=[['Bundle ID',job.externalBundleId!],['Transaction ID','TX-123456'],['Total Paid','$126.69']];
    const parsed=parseMiFileReceiptFields(fields,job,account,'payment',null);
    assert.equal(parsed.totalCents,12669);validateReceipt(parsed,job,account);
    for(const bad of [fields.slice(0,2),[...fields,fields[0]],fields.map(row=>row[0]==='Bundle ID'?['Bundle ID','another-bundle']:row)]) {
        assert.throws(()=>parseMiFileReceiptFields(bad,job,account,'payment',null));
    }
    assert.throws(()=>validateReceipt({...parsed,receiptUrl:'https://other.example/receipt'},job,account));
    assert.throws(()=>validateReceipt({...parsed,status:'Filed'},job,account));
    const pdf=testPdfFixture(fields.map(row=>row.join(': ')).join('\n'));
    assert.equal((await parseMiFileReceiptPdf(pdf,job,account,'payment',null)).totalCents,12669);
});
test('receipt events deduplicate, reject conflicting totals and remain scoped to the account',()=>{
    const {db,store,job}=storeFixture();
    try {
        const observation=parseMiFileReceiptFields([['Bundle ID',job.externalBundleId!],['Receipt Number','R-123456'],['Total Paid','$126.69']],job,account,'payment',null);
        for(let index=0;index<2;index++) {
            const work=store.queue(job.id,'receipts',account);store.claim();
            store.complete(work.id,{kind:'receipts',observations:[{...observation,observedAt:new Date(Date.now()+index).toISOString()}],state:'found',checkedAt:new Date().toISOString(),issue:null},account);
        }
        assert.equal(store.state(job.id,account).receipts.length,1);
        const work=store.queue(job.id,'receipts',account);store.claim();
        assert.throws(()=>store.complete(work.id,{kind:'receipts',observations:[{...observation,totalCents:1}],state:'found',checkedAt:new Date().toISOString(),issue:null},account),/Conflicting/);
        store.fail(work.id,'Conflicting receipt');
        assert.equal(store.state(job.id,{...account,identity:digest('other-account')}).receipts.length,0);
    } finally{db.close();}
});
test('checkout browser adapter reads fees and cancels without clicking Submit or adding payment methods',async()=>{
    const {openCheckoutForInspection,readCheckoutForInspection}=require('./mifileCheckoutRunner') as typeof import('./mifileCheckoutRunner');
    const page=await browser.newPage();
    try {
        await page.setContent(`<button onclick="document.querySelector('[role=dialog]').hidden=false">Next</button>
            <div role="dialog" hidden><h2>Checkout</h2><table aria-label="Fees"><tbody>${fees.map(row=>'<tr><td>'+row[0]+'</td><td>'+row[1]+'</td></tr>').join('')}</tbody></table>
            <fieldset><legend>Available Payment Accounts</legend></fieldset><p>No payment methods exist for your account, please add one.</p>
            <button onclick="window.paid=true">Submit</button><button onclick="window.added=true">Add Payment Account</button>
            <button onclick="this.parentElement.hidden=true">Cancel</button></div>`);
        await openCheckoutForInspection(page);const snapshot=await readCheckoutForInspection(page);
        assert.deepEqual(snapshot.rows,fees);assert.equal(snapshot.method.state,'missing');
        await page.getByRole('button',{name:'Cancel',exact:true}).click();
        assert.equal(await page.evaluate(()=>Boolean((window as any).paid||(window as any).added)),false);
    } finally{await page.close();}
});
test('unrecognized checkout notices are not accepted',async()=>{
    const {openCheckoutForInspection}=require('./mifileCheckoutRunner') as typeof import('./mifileCheckoutRunner');
    const page=await browser.newPage();
    try {
        await page.setContent(`<button onclick="document.querySelector('[role=dialog]').hidden=false">Next</button>
            <div role="dialog" hidden><h2>Case Initiation Warning</h2><p>Agree to additional terms and authorize payment.</p>
            <button onclick="window.accepted=true">Continue</button></div>`);
        await assert.rejects(openCheckoutForInspection(page),/unfamiliar/);
        assert.equal(await page.evaluate(()=>Boolean((window as any).accepted)),false);
    } finally{await page.close();}
});
test('live nested MiFILE warning and checkout dialogs resolve to their inner content only',async()=>{
    const {openCheckoutForInspection,readCheckoutForInspection}=require('./mifileCheckoutRunner') as typeof import('./mifileCheckoutRunner');
    const page=await browser.newPage();
    try {
        await page.setContent(`<button onclick="document.getElementById('warning').hidden=false">Next</button>
            <div role="dialog" id="warning" hidden><div role="dialog"><h3>Case Initiation Warning</h3>
            <p>After submitting, you will no longer be able to file documents to this case until a case number has been assigned.</p>
            <p>If you would like to file additional documents to this case immediately, please cancel and add them now.</p>
            <button onclick="document.getElementById('warning').hidden=true;document.getElementById('checkout').hidden=false">Continue</button></div></div>
            <div role="dialog" id="checkout" hidden><div role="dialog"><h3>Checkout</h3><table aria-label="Fees"><tbody>
            ${fees.map(row=>'<tr><td>'+row[0]+'</td><td>'+row[1]+'</td></tr>').join('')}</tbody></table>
            <fieldset><legend>Available Payment Accounts</legend></fieldset><p>No payment methods exist for your account.</p>
            <button onclick="window.paid=true">Submit</button><button onclick="document.getElementById('checkout').hidden=true">Cancel</button></div></div>`);
        await openCheckoutForInspection(page);
        assert.equal((await readCheckoutForInspection(page)).rows.length,5);
        assert.equal(await page.evaluate(()=>Boolean((window as any).paid)),false);
    }finally{await page.close();}
});
