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
import {parseMiFileReceiptFields,parseMiFileReceiptPdf,collectReceiptObservations} from './mifileReceipts';
import {testPdfFixture} from './testPdfFixture';
import {readPaymentMethods,selectPaymentMethodForQuote} from './mifilePaymentMethods';

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
        const rotated={...account,identity:digest('other-revision')};
        assert.equal(store.state(job.id,rotated).receipts.length,1);
        assert.equal(store.state(job.id,rotated).receiptSummary.submissionObserved,true);
        assert.equal(store.state(job.id,{...rotated,username:'different@example.com'}).receipts.length,0);
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
test('receipt collector recognizes only the exact editable saved bundle as Unsubmitted, never as Paid',async()=>{
    const page=await browser.newPage(),job=prepared();
    try {
        await page.route('**/*',route=>route.fulfill({contentType:'text/html',body:`<header>${account.username}</header>
            <main>Case Number: TEMP-QA<table id="documentTable"><tr><td>Complaint.pdf</td></tr></table><button>Save Progress</button></main>`}));
        const result=await collectReceiptObservations(page,job,account);
        assert.equal(result.kind,'receipts');
        if(result.kind!=='receipts') throw new Error('Wrong fixture result');
        assert.equal(result.state,'unsubmitted');
        assert.equal(receiptSummary(result.observations).paymentReported,false);
        assert.equal(result.observations[0].bundleId,job.externalBundleId);
        assert.deepEqual(receiptSummary(result.observations).courtFiledDocumentIds,[]);
    }finally{await page.close();}
});
test('checkout waits for asynchronous fee calculation instead of freezing the initial zero total',async()=>{
    const {readVerifiedCheckoutQuote}=require('./mifileCheckoutRunner') as typeof import('./mifileCheckoutRunner');
    const page=await browser.newPage(),job=prepared();
    try {
        await page.setContent(`<div role="dialog"><h3>Checkout</h3><table aria-label="Fees"><tbody><tr><td>Total</td><td>$0.00</td></tr></tbody></table>
            <fieldset><legend>Available Payment Accounts</legend></fieldset><p>No payment methods exist for your account.</p>
            <script>setTimeout(()=>document.querySelector('tbody').innerHTML=${JSON.stringify(fees.map(row=>'<tr><td>'+row[0]+'</td><td>'+row[1]+'</td></tr>').join(''))},750)</script></div>`);
        const result=await readVerifiedCheckoutQuote(page,job,account,{packageDigest:(job.result!.savedBundleEvidence as any).packageDigest,sourceFeeSubtotalCents:10300});
        assert.equal(result.totalCents,12669);
    } finally{await page.close();}
});

const accountTokenA='11111111-2222-3333-4444-555555555555';
const accountTokenB='aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const available=[{fingerprint:digest(accountTokenA),label:'Card ending 1234'},
    {fingerprint:digest(accountTokenB),label:'Bank account ending 5678'}];

test('saved payment accounts expose masked labels only and require an exact explicit choice',async()=>{
    const page=await browser.newPage();
    try {
        await page.setContent(`<div role="dialog"><h2>Checkout</h2><fieldset><legend>Available Payment Accounts</legend>
            <label><input type="radio" name="method" value="${accountTokenA}">Visa ending in 1234, Private Owner 4111111111111234</label>
            <label><input type="radio" name="method" value="${accountTokenB}">Bank account **5678 Private Bank 123456785678</label></fieldset>
            <button onclick="window.paid=true">Submit</button><button onclick="window.added=true">Add Payment Account</button></div>`);
        const before=await readPaymentMethods(page);
        assert.equal(before.state,'not_selected');assert.equal(before.fingerprint,null);
        assert.deepEqual(before.available,available);
        assert.ok(!JSON.stringify(before).includes('Private'));assert.ok(!JSON.stringify(before).includes(accountTokenA));
        await assert.rejects(selectPaymentMethodForQuote(page,digest('unknown')),/no longer available/);
        assert.equal((await readPaymentMethods(page)).state,'not_selected');
        await selectPaymentMethodForQuote(page,available[1].fingerprint);
        assert.equal((await readPaymentMethods(page)).fingerprint,available[1].fingerprint);
        assert.equal(await page.evaluate(()=>Boolean((window as any).paid || (window as any).added)),false);
    }finally{await page.close();}
});

test('payment account selection supports visible labels for hidden radios and native selectors',async()=>{
    const page=await browser.newPage();
    try {
        for (const control of [`<input id="methodA" type="radio" style="display:none" value="${accountTokenA}"><label for="methodA">Card ending 1234</label>`,
            `<select aria-label="Payment account"><option value="">Select</option><option value="${accountTokenA}">Card ending 1234</option></select>`]) {
            await page.setContent(`<div role="dialog"><h2>Checkout</h2><fieldset><legend>Available Payment Accounts</legend>${control}</fieldset></div>`);
            await selectPaymentMethodForQuote(page,available[0].fingerprint);
            assert.equal((await readPaymentMethods(page)).fingerprint,available[0].fingerprint);
        }
    }finally{await page.close();}
});

test('unknown, duplicate, contradictory and multiple selected payment controls fail closed',async()=>{
    const page=await browser.newPage();
    try {
        const radio=(value:string)=>`<label><input type="radio" checked value="${value}">Card ending 1234</label>`;
        for(const controls of [radio('4111111111111111'),radio(accountTokenA)+radio(accountTokenA),
            radio(accountTokenA)+radio(accountTokenB),radio(accountTokenA)+'<p>No payment methods exist for your account</p>']) {
            await page.setContent(`<div role="dialog"><h2>Checkout</h2><fieldset><legend>Available Payment Accounts</legend>${controls}</fieldset></div>`);
            await assert.rejects(readPaymentMethods(page));
        }
        await page.setContent(`<div role="dialog"><h2>Checkout</h2><fieldset><legend>Available Payment Accounts</legend>
            <select disabled><option value="${accountTokenA}">Card ending 1234</option></select></fieldset></div>`);
        await assert.rejects(readPaymentMethods(page),/not readable/);
    }finally{await page.close();}
});

test('the live empty payment panel is missing, not an unselected account, and never clicks Add',async()=>{
    const page=await browser.newPage();
    try {
        await page.setContent(`<fieldset aria-label="Available Payment Accounts"><div>Available Payment Accounts</div>
            <button onclick="window.added=true">Add Payment Account</button></fieldset>`);
        // The vendor nests this exact empty fieldset inside its Checkout dialog.
        await page.setContent(`<div role="dialog"><h2>Checkout</h2>${await page.locator('fieldset').evaluate(el=>el.outerHTML)}</div>`);
        const result=await readPaymentMethods(page);
        assert.equal(result.state,'missing');assert.equal(result.fingerprint,null);assert.deepEqual(result.available,[]);
        assert.equal(await page.evaluate(()=>Boolean((window as any).added)),false);
    }finally{await page.close();}
});

test('checkout waits for asynchronously rendered payment controls before recording availability',async()=>{
    const {readVerifiedCheckoutQuote}=require('./mifileCheckoutRunner') as typeof import('./mifileCheckoutRunner');
    const page=await browser.newPage(),job=prepared();
    try {
        await page.setContent(`<div role="dialog"><h2>Checkout</h2><table aria-label="Fees"><tbody>
            ${fees.map(row=>'<tr><td>'+row[0]+'</td><td>'+row[1]+'</td></tr>').join('')}</tbody></table>
            <fieldset><legend>Available Payment Accounts</legend><div id="accounts">Loading</div></fieldset>
            <script>setTimeout(()=>document.getElementById('accounts').innerHTML=${JSON.stringify(`<label><input type="radio" value="${accountTokenA}">Card ending 1234</label>`)},700)</script></div>`);
        const result=await readVerifiedCheckoutQuote(page,job,account,{packageDigest:(job.result!.savedBundleEvidence as any).packageDigest,
            sourceFeeSubtotalCents:10300});
        assert.equal(result.paymentMethodState,'not_selected');assert.deepEqual(result.availablePaymentMethods,[available[0]]);
    }finally{await page.close();}
});

function completeQuote(fixture:ReturnType<typeof storeFixture>,methodState:'selected'|'not_selected'='selected',now=Date.now(),
    currentAccount=account,amounts=fees) {
    const q=buildCheckoutQuote(fixture.job,currentAccount,amounts,{state:methodState,
        fingerprint:methodState==='selected'?available[0].fingerprint:null,available},
        (fixture.job.result!.savedBundleEvidence as any).packageDigest,10300,now);
    const work=fixture.store.queue(fixture.job.id,'quote',currentAccount);fixture.store.claim();
    fixture.store.complete(work.id,{kind:'quote',quote:q},currentAccount);
    return q;
}

function completeUnsubmitted(fixture:ReturnType<typeof storeFixture>,currentAccount=account) {
    const work=fixture.store.queue(fixture.job.id,'receipts',currentAccount);fixture.store.claim();
    fixture.store.complete(work.id,{kind:'receipts',observations:[receipt()],state:'unsubmitted',
        checkedAt:new Date().toISOString(),issue:null},currentAccount);
}

test('payment choice is persistent, account-scoped and never accepts an arbitrary fingerprint',()=>{
    const f=storeFixture();
    try {
        const q=completeQuote(f,'not_selected'),input={quoteId:q.id,quoteDigest:q.quoteDigest,fingerprint:available[0].fingerprint};
        assert.throws(()=>f.store.choosePaymentMethod(f.job.id,{...input,fingerprint:digest('injected')},account,'qa'));
        assert.throws(()=>f.store.choosePaymentMethod(f.job.id,input,{...account,identity:digest('other-revision')},'qa'));
        assert.throws(()=>f.store.choosePaymentMethod(f.job.id,input,account,'qa',Date.now()+900001));
        f.store.choosePaymentMethod(f.job.id,input,account,'qa');
        const {CheckoutStore}=require('./checkoutStore') as typeof import('./checkoutStore');
        const reopened=new CheckoutStore(f.sql,()=>f.job,()=>{});
        assert.equal(reopened.paymentMethodChoice(f.job.id,account),input.fingerprint);
        assert.equal(reopened.paymentMethodChoice(f.job.id,{...account,identity:digest('revision-2')}),null);
        assert.equal(f.store.state(f.job.id,account).canConfirm,false);
        const work=f.store.queue(f.job.id,'quote',account);
        assert.throws(()=>f.store.choosePaymentMethod(f.job.id,input,account,'qa'));
        assert.throws(()=>f.store.clearPaymentMethod(f.job.id,account));
        f.store.claim();f.store.fail(work.id,'Account removed');
        f.store.clearPaymentMethod(f.job.id,account);
        assert.equal(f.store.paymentMethodChoice(f.job.id,account),null);
        assert.equal(f.store.state(f.job.id,account).canConfirm,false);
    }finally{f.db.close();}
});

test('changing or clearing payment choice invalidates earlier amount review and requires new quote',()=>{
    const f=storeFixture();
    try {
        const q=completeQuote(f),review={quoteId:q.id,quoteDigest:q.quoteDigest,totalCents:q.totalCents};
        f.store.confirm(f.job.id,review,account,'qa');assert.ok(f.store.state(f.job.id,account).confirmedAt);
        const changedAt=Date.now();
        f.store.choosePaymentMethod(f.job.id,{quoteId:q.id,quoteDigest:q.quoteDigest,fingerprint:available[0].fingerprint},account,'qa',changedAt);
        assert.equal(f.store.state(f.job.id,account).confirmedAt,null);
        assert.throws(()=>f.store.confirm(f.job.id,review,account,'qa'));
        const fresh=completeQuote(f,'selected',changedAt+1);
        assert.equal(f.store.state(f.job.id,account).canConfirm,true);
        f.store.confirm(f.job.id,{quoteId:fresh.id,quoteDigest:fresh.quoteDigest,totalCents:fresh.totalCents},account,'qa');
        f.store.clearPaymentMethod(f.job.id,account,'qa',changedAt+2);
        assert.equal(f.store.state(f.job.id,account).confirmedAt,null);
        completeQuote(f,'not_selected',changedAt+3);
        assert.equal(f.store.state(f.job.id,account).checkoutVerified,true);
        assert.equal(f.store.state(f.job.id,account).canConfirm,false);
    }finally{f.db.close();}
});

test('a changed or missing chosen account cannot complete the quote inspection',()=>{
    const f=storeFixture();
    try {
        const q=completeQuote(f,'not_selected');
        f.store.choosePaymentMethod(f.job.id,{quoteId:q.id,quoteDigest:q.quoteDigest,fingerprint:available[1].fingerprint},account,'qa');
        assert.throws(()=>completeQuote(f),/did not retain/);
        const active=f.store.state(f.job.id,account).inspection!;f.store.fail(active.id,'Chosen method not retained');
        f.store.clearPaymentMethod(f.job.id,account);
        assert.equal(f.store.paymentMethodChoice(f.job.id,account),null);
    }finally{f.db.close();}
});

test('preflight records a primary-account real package only after fresh quote, exact review and receipt check',()=>{
    const f=storeFixture(),primary={...account,accountEnvironment:'production',productionConfirmed:true};
    try {
        f.job.payload!.subject='NEW LT FILING - Example Plaintiff v Example Defendant';
        const evidence=f.job.result!.savedBundleEvidence as any;
        evidence.packageDigest=preparationDigest(f.job.payload!,evidence.sources);
        const q=completeQuote(f,'selected',Date.now(),primary),input={quoteId:q.id,quoteDigest:q.quoteDigest,totalCents:q.totalCents};
        f.store.confirm(f.job.id,input,primary,'qa');
        assert.equal(f.store.state(f.job.id,primary).preflight.complete,false);
        completeUnsubmitted(f,primary);
        assert.ok(f.store.state(f.job.id,primary).preflight.recordedAt);
        f.store.confirm(f.job.id,input,primary,'qa');
        assert.equal(f.sql.prepare('SELECT count(*) AS n FROM mifile_submission_preflights').get().n,1);
        const snapshot=JSON.parse(f.sql.prepare('SELECT snapshot_json FROM mifile_submission_preflights').get().snapshot_json);
        assert.equal(snapshot.paymentMethodFingerprint,available[0].fingerprint);
        assert.equal(snapshot.paymentAuthorized,false);assert.equal(snapshot.courtSubmissionAuthorized,false);
        assert.equal(snapshot.executionKey,digest([primary.identity,f.job.externalBundleId]));
        assert.equal(f.store.state(f.job.id,primary,Date.now()+900001).preflight.complete,false);
        assert.equal(f.store.state(f.job.id,account).preflight.complete,false);
        assert.equal(f.store.state(f.job.id,primary).preflight.executionEnabled,false);
    }finally{f.db.close();}
});

test('QA packages cannot produce live preflight records and corrupt receipt evidence blocks checkout',()=>{
    const f=storeFixture(),primary={...account,accountEnvironment:'production',productionConfirmed:true};
    try {
        const q=completeQuote(f,'selected',Date.now(),primary);completeUnsubmitted(f,primary);
        f.store.confirm(f.job.id,{quoteId:q.id,quoteDigest:q.quoteDigest,totalCents:q.totalCents},primary,'qa');
        assert.equal(f.store.state(f.job.id,primary).preflight.complete,false);
        assert.equal(f.sql.prepare('SELECT count(*) AS n FROM mifile_submission_preflights').get().n,0);
        f.sql.prepare("UPDATE mifile_receipt_events SET event_json = '{invalid'").run();
        assert.equal(f.store.state(f.job.id,primary).canConfirm,false);
        assert.throws(()=>f.store.queue(f.job.id,'quote',primary),/Reconcile/);
    }finally{f.db.close();}
});

test('reported submission, payment failure or payment blocks new checkout and amount confirmation',()=>{
    for(const status of ['Submitted','Paid','Payment Rejected'] as const) {
        const f=storeFixture();
        try {
            const q=completeQuote(f),work=f.store.queue(f.job.id,'receipts',account);f.store.claim();
            f.store.complete(work.id,{kind:'receipts',observations:[receipt(status)],state:'found',checkedAt:new Date().toISOString(),issue:null},account);
            assert.equal(f.store.state(f.job.id,account).canConfirm,false);
            assert.throws(()=>f.store.confirm(f.job.id,{quoteId:q.id,quoteDigest:q.quoteDigest,totalCents:q.totalCents},account,'qa'));
            assert.throws(()=>f.store.queue(f.job.id,'quote',account),/Reconcile/);
            assert.throws(()=>f.store.choosePaymentMethod(f.job.id,{quoteId:q.id,quoteDigest:q.quoteDigest,fingerprint:available[0].fingerprint},account,'qa'));
            assert.equal(f.store.state(f.job.id,account).receiptSummary.retryPaymentAllowed,false);
            assert.equal(f.store.queue(f.job.id,'receipts',account).kind,'receipts');
        }finally{f.db.close();}
    }
});

test('invalid public payment choices and mismatched state cannot form an actionable quote',()=>{
    const job=prepared(),q=quote(job);
    assert.throws(()=>buildCheckoutQuote(job,account,fees,{state:'not_selected',fingerprint:method.fingerprint},q.packageDigest,10300));
    for(const unsafe of [[{fingerprint:available[0].fingerprint,label:'Visa 4111111111111234'}],[available[0],available[0]],'bad']) {
        const bad={...q,availablePaymentMethods:unsafe} as any;bad.quoteDigest=quoteDigest(bad);
        assert.ok(checkoutReviewIssues(bad,job,account).some(issue=>issue.includes('invalid')));
    }
});
