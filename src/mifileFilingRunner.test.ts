import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { after, before } from 'node:test';
import { chromium, Browser, Page } from 'playwright';
import type { FilingDocumentPayload, FilingJobView, FilingPayload } from './database';
import { createHash } from 'node:crypto';
import { filingReleaseChecks, isRequiredMiFileFiler, miFileBundleId, preparationDigest, usdCents } from './mifilePreparationEvidence';
import { testPdfFixture } from './testPdfFixture';

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mifile-runner-qa-'));
let browser: Browser;
let MiFileFilingRunner: typeof import('./mifileFilingRunner').MiFileFilingRunner;

before(async () => {
    Object.assign(process.env, {
        TENANT_ID:'11111111-1111-1111-1111-111111111111',CLIENT_ID:'qa-client',CLIENT_SECRET:'qa-secret',
        USER_EMAIL:'qa@example.com',ONEDRIVE_ROOT_SHARE_URL:'https://onedrive.example/root',
        WORKFLOW_DB_PATH: path.join(directory, 'workflow.sqlite'),
        MIFILE_FILING_DEBUG_DIR: directory, MIFILE_KEEP_FILING_TEMP: 'false',
        MIFILE_USER: 'qa@example.com', MIFILE_PASSWORD: 'qa-only',
        MIFILE_ACCOUNT_ENVIRONMENT: 'test', MIFILE_EXPECTED_ACCOUNT_EMAIL: 'qa@example.com',
    });
    MiFileFilingRunner = require('./mifileFilingRunner').MiFileFilingRunner;
    browser = await chromium.launch({ headless: true });
});

after(async () => {
    await browser?.close();
    require('./database').getWorkflowDatabase().close();
    fs.rmSync(directory, { recursive: true, force: true });
});

function filingDocument(index: number, connected = false): FilingDocumentPayload {
    return {
        id: 'doc-' + index, filename: `Document-${index}.pdf`, filingName: `Document ${index}`,
        filingType: index === 0 ? 'Complaint for Possession Only' : 'Other',
        filingRelation: connected ? 'connected_to_complaint' : 'separate',
        packageRole: index === 0 ? 'complaint' : 'ancillary',
        oneDriveUrl: `https://onedrive.example/doc-${index}`, mimeType: 'application/pdf',
        fileSize: 200, isPrimary: index === 0,
    };
}

async function caseTypePage(options: { delayed?: boolean; ignoreClick?: boolean; wrongType?: boolean } = {}): Promise<Page> {
    const page = await browser.newPage();
    await page.route('**/*', route => route.abort());
    await page.setContent(`<input id="searchField"><div id="treeHost"></div><script>
        const options = ${JSON.stringify(options)};
        function initialise() {
            searchField.value = '';
            treeHost.innerHTML = '<ul role="tree"><li role="treeitem" aria-level="1">Housing and Real Estate Suits</li>' +
                '<li role="treeitem" aria-level="2" aria-selected="false" style="display:none">' +
                (options.wrongType ? 'GC - Civil cases for money damages except landlord-tenant' : 'LT - Landlord-Tenant Summary Proceedings') + '</li></ul>';
            const leaf = treeHost.querySelector('[aria-level="2"]');
            searchField.oninput = () => leaf.style.display = searchField.value === 'Landlord' ? 'block' : 'none';
            leaf.onclick = () => { if (!options.ignoreClick) leaf.setAttribute('aria-selected', 'true'); };
        }
        if (options.delayed) setTimeout(initialise, 150); else initialise();
        </script>`);
    return page;
}

test('MiFILE waits for the court case-type tree before filtering and verifies the LT selection', async () => {
    for (const delayed of [false, true]) {
        const page = await caseTypePage({ delayed });
        try {
            const runner = new MiFileFilingRunner();
            (runner as any).timeoutMs = 1_000;
            await (runner as any).selectCaseType(page, 'LT - Landlord-Tenant Summary Proceedings');
            assert.equal(await page.getByRole('treeitem', { name: 'LT - Landlord-Tenant Summary Proceedings', exact: true })
                .getAttribute('aria-selected'), 'true');
        } finally { await page.close(); }
    }
});

test('MiFILE stops when the court does not confirm the selected case type', async () => {
    const page = await caseTypePage({ ignoreClick: true });
    try {
        const runner = new MiFileFilingRunner();
        (runner as any).timeoutMs = 300;
        await assert.rejects((runner as any).selectCaseType(page, 'LT - Landlord-Tenant Summary Proceedings'),
            (error: any) => error.code === 'CASE_TYPE_SELECTION_UNCONFIRMED' && error.checkpoint === 'select_filing');
    } finally { await page.close(); }
});

test('MiFILE never selects another case type merely because its description mentions landlord-tenant', async () => {
    const page = await caseTypePage({ wrongType: true });
    try {
        const runner = new MiFileFilingRunner();
        (runner as any).timeoutMs = 300;
        await assert.rejects((runner as any).selectCaseType(page, 'LT - Landlord-Tenant Summary Proceedings'));
        assert.equal(await page.locator('[aria-selected="true"]').count(), 0);
    } finally { await page.close(); }
});

test('MiFILE case forms keep business Defendants separate from people',async()=>{
    const page=await browser.newPage();
    try {
        await page.route('**/*',route=>route.abort());
        await page.setContent([0,1,2].map(index=>{
            const p='psn'+index;
            return `<input type="radio" id="${p}IsPerson_0" name="${p}type"><input type="radio" id="${p}IsPerson_1" name="${p}type">`+
                ['EntityName','FirstName','MiddleName','FamilyName','Suffix','Address','Address2','City','Zip','Phone','Email']
                    .map(name=>`<input id="${p}${name}">`).join('')+
                `<select id="${p}Country"><option value="US">US</option></select><select id="${p}State"><option>Michigan</option></select>`;
        }).join(''));
        const runner=new MiFileFilingRunner();
        const base={id:'party',displayName:'Example Ventures LLC',partyType:'entity',entityName:'Example Ventures LLC',
            address1:'100 Main Street',city:'Wayne',state:'MI',postalCode:'48184'};
        await (runner as any).fillParty(page.mainFrame(),0,base,false);
        for(const [index,first,last] of [[1,'Morgan','Tenant'],[2,'Taylor','Resident']] as const)
            await (runner as any).fillParty(page.mainFrame(),index,{...base,partyType:'person',entityName:null,firstName:first,lastName:last},false);
        assert.equal(await page.locator('#psn0IsPerson_1').isChecked(),true);
        assert.equal(await page.locator('#psn0EntityName').inputValue(),'Example Ventures LLC');
        assert.equal(await page.locator('#psn1FirstName').inputValue(),'Morgan');
        assert.equal(await page.locator('#psn2FamilyName').inputValue(),'Resident');
    } finally {await page.close();}
});

async function uploadPage(options: { missingType?: boolean; missingConnect?: boolean; feeLabels?: boolean; noOther?: boolean;
    noConnectEffect?: boolean; insertFirst?: boolean; failedFile?: string; warningFile?: string; merged?: boolean; systemParent?: boolean } = {}): Promise<Page> {
    const page = await browser.newPage();
    await page.route('**/*', route => route.abort());
    await page.setContent(`<input id="fileUpload" type="file" multiple><table id="files"></table>
        <button onclick="window.saved = true">Save Progress</button>
        <button onclick="window.submitted = true">Submit</button>
        <script>
        const config = ${JSON.stringify(options)};
        window.uploadSelections = [];
        window.filings = config.systemParent ? [{source:'system',name:'Case initiation',type:'System',children:[],status:'uploaded'}] : [];
        function makeRow(model,id,index,child) {
            const row = document.createElement('tbody'); row.id = id;
            row.dataset.source = model.source; row.dataset.selectedType = model.type || '';
            row.innerHTML = '<tr><td></td><td><input name="documentName_' + index + '"></td><td></td><td>1 KB</td><td></td><td></td></tr>';
            const name = row.querySelector('input'); name.value = model.name; name.oninput = () => model.name = name.value;
            const state = row.querySelectorAll('td')[5];
            state.innerHTML = '<span class="glyphicon-ok" style="display:' + (model.status==='uploaded'?'inline':'none') + '">Uploaded</span>' +
                '<span class="glyphicon-remove" ng-show="parent.uploadStatus==FAILED" style="display:' + (model.status==='failed'?'inline':'none') + '">Upload failed</span>' +
                '<span class="glyphicon-alert" ng-show="parent.uploadStatus==WARNING" style="display:' + (model.status==='warning'?'inline':'none') + '">Redaction warning</span>';
            const typeCell = row.querySelectorAll('td')[4];
            if (child) typeCell.textContent = model.type;
            else {
                typeCell.innerHTML = '<input id="selectFilingTypeInput_' + index + '"><ul class="dropdown-menu" style="display:none">' +
                    '<li role="option">Complaint for Possession Only (Different type)</li>' +
                    (config.missingType ? '' : '<li role="option">Complaint for Possession Only' + (config.feeLabels?' - $45.00':'') + '</li>') +
                    (config.noOther ? '' : '<li role="option">Other' + (config.feeLabels?' - $0.00':'') + '</li>') + '</ul>';
                const input = typeCell.querySelector('input'); input.value = model.type || '';
                input.oninput = () => {
                    input.classList.add('ng-invalid-editable');
                    document.querySelectorAll('.dropdown-menu').forEach(menu=>menu.style.display='none');
                    typeCell.querySelector('.dropdown-menu').style.display='block';
                };
                typeCell.querySelectorAll('[role="option"]').forEach(option=>option.onclick=()=>{
                    model.type = option.textContent; row.dataset.selectedType = model.type; input.value = model.type;
                    input.classList.remove('ng-invalid-editable'); typeCell.querySelector('.dropdown-menu').style.display='none';
                });
                if (!config.missingConnect && index > 0) {
                    const connect=document.createElement('button'); connect.type='button'; connect.id=id+'-connect-filing'; connect.textContent='Connect';
                    connect.onclick=()=>{
                        if(config.noConnectEffect)return;
                        const parent=window.filings[index-1]; model.type=config.merged?'MERGED FILING':'CONNECTED FILING'; parent.children.push(model);
                        window.filings.splice(index,1); render();
                    };
                    row.querySelector('td').append(connect);
                }
            }
            return row;
        }
        function render(){
            files.replaceChildren();
            window.filings.forEach((parent,index)=>{
                files.append(makeRow(parent,'filing-'+index,index,false));
                parent.children.forEach((child,childIndex)=>files.append(makeRow(child,'child-'+index+'-'+childIndex,childIndex,true)));
            });
        }
        fileUpload.onchange = () => {
            window.uploadSelections.push(Array.from(fileUpload.files).map(file=>file.name));
            Array.from(fileUpload.files).forEach(file=>{
                const item={source:file.name,name:file.name.replace(/\\.pdf$/i,''),type:'',children:[],
                    status:file.name===config.failedFile?'failed':file.name===config.warningFile?'warning':'uploaded'};
                if(config.insertFirst)window.filings.unshift(item);else window.filings.push(item);
            }); render();
        };
        render();
        </script>`);
    return page;
}

function materialized(count: number, connected = false) {
    return Array.from({ length: count }, (_, index) => {
        const document = filingDocument(index, connected && index === 1);
        const localPath = path.join(directory, document.filename);
        fs.writeFileSync(localPath, testPdfFixture());
        return { document, localPath };
    });
}

test('MiFILE uploader assigns all PDFs using exact Filing Types and connects the ancillary document', async () => {
    const page = await uploadPage();
    try {
        const runner = new MiFileFilingRunner();
        const receipt = await (runner as any).uploadDocuments(page, materialized(6, true));
        assert.equal(await page.locator('tbody').count(), 6);
        assert.equal(await page.locator('#filing-0').getAttribute('data-selected-type'), 'Complaint for Possession Only');
        assert.equal(await page.locator('#child-0-0').getAttribute('data-selected-type'), 'CONNECTED FILING');
        assert.equal(receipt[1].parentDocumentId, 'doc-0');
        assert.equal(await page.locator('#filing-4 input[name^="documentName_"]').inputValue(), 'Document 5');
        assert.ok((await page.evaluate(() => (window as any).uploadSelections)).every((batch: string[]) => batch.length === 1));
        assert.equal(await page.evaluate(() => Boolean((window as any).saved || (window as any).submitted)), false);
    } finally { await page.close(); }
});

test('similar Filing Type labels must not be accepted in place of the requested type', async () => {
    const page = await uploadPage({ missingType: true });
    try {
        const runner = new MiFileFilingRunner();
        (runner as any).timeoutMs = 300;
        await assert.rejects((runner as any).uploadDocuments(page, materialized(1)), (error: any) =>
            error.code === 'FILING_TYPE_NOT_AVAILABLE' && error.checkpoint === 'document_upload');
        assert.equal(await page.locator('#filing-0').getAttribute('data-selected-type'), '');
        assert.equal(await page.evaluate(() => Boolean((window as any).saved || (window as any).submitted)), false);
    } finally { await page.close(); }
});

test('live MiFILE fee suffixes preserve exact Filing Type matching for every PDF', async () => {
    const page = await uploadPage({feeLabels: true});
    try {
        await (new MiFileFilingRunner() as any).uploadDocuments(page, materialized(6));
        assert.equal(await page.locator('#filing-0').getAttribute('data-selected-type'), 'Complaint for Possession Only - $45.00');
        assert.equal(await page.locator('#filing-5').getAttribute('data-selected-type'), 'Other - $0.00');
        assert.equal(await page.evaluate(() => Boolean((window as any).saved || (window as any).submitted)), false);
    } finally { await page.close(); }
});

test('missing Connected control must fail before saving instead of silently creating a separate filing', async () => {
    const page = await uploadPage({ missingConnect: true });
    try {
        await assert.rejects((new MiFileFilingRunner() as any).uploadDocuments(page, materialized(2, true)),
            (error: any) => error.code === 'CONNECTED_FILING_UNAVAILABLE');
        assert.equal(await page.evaluate(() => Boolean((window as any).saved || (window as any).submitted)), false);
    } finally { await page.close(); }
});

test('several Connected PDFs remain under the same Complaint after MiFILE renumbers rows, without selecting Other', async () => {
    const page = await uploadPage({ noOther: true, systemParent: true });
    const documents = materialized(4);
    documents.slice(1).forEach(item => { item.document.filingRelation = 'connected_to_complaint'; });
    const originalOrder = documents.map(item => item.document.id);
    try {
        const receipts = await (new MiFileFilingRunner() as any).uploadDocuments(page, [documents[3], documents[0], documents[1], documents[2]]);
        assert.deepEqual(documents.map(item => item.document.id), originalOrder);
        assert.equal(await page.locator('tbody[id^="filing-"]').count(), 2);
        assert.equal(await page.locator('tbody[id^="child-1-"]').count(), 3);
        assert.equal(receipts[0].documentId, 'doc-0');
        for (const receipt of receipts.slice(1)) {
            assert.equal(receipt.parentDocumentId, 'doc-0');
            assert.equal(receipt.filingType, 'CONNECTED FILING');
            assert.equal(await page.locator('#' + receipt.mifileRowId).getAttribute('data-source'), `Document-${receipt.documentId.slice(4)}.pdf`);
        }
        assert.equal(await page.locator('#filing-0 input').first().inputValue(), 'Case initiation');
        assert.equal(await page.evaluate(() => Boolean((window as any).saved || (window as any).submitted)), false);
    } finally { await page.close(); }
});

test('unexpected source-row reordering stops classification rather than assigning a type to another PDF', async () => {
    const page = await uploadPage({ insertFirst: true });
    try {
        await assert.rejects((new MiFileFilingRunner() as any).uploadDocuments(page, materialized(2)), (error: any) => error.code === 'UPLOAD_SOURCE_MISMATCH');
        assert.equal(await page.locator('#filing-1').getAttribute('data-source'), 'Document-0.pdf');
        assert.equal(await page.locator('#filing-1').getAttribute('data-selected-type'), 'Complaint for Possession Only');
        assert.equal(await page.evaluate(() => Boolean((window as any).saved || (window as any).submitted)), false);
    } finally { await page.close(); }
});

test('a failed upload names the exact PDF and does not proceed to later uploads or saving', async () => {
    const page = await uploadPage({ failedFile: 'Document-1.pdf' });
    const log: any[] = [];
    try {
        await assert.rejects((new MiFileFilingRunner(entry => { log.push(entry); }) as any).uploadDocuments(page, materialized(3)),
            (error: any) => error.code === 'DOCUMENT_UPLOAD_FAILED' && error.message.includes('Document-1.pdf'));
        assert.equal((await page.evaluate(() => (window as any).uploadSelections)).length, 2);
        assert.equal(log.find(entry => entry.details?.event === 'document_failed').details.documentId, 'doc-1');
        assert.equal(log.filter(entry => entry.details?.event === 'document_ready').length, 1);
        assert.equal(await page.evaluate(() => Boolean((window as any).saved || (window as any).submitted)), false);
    } finally { await page.close(); }
});

test('redaction warnings and ignored/merged connection controls require review instead of reporting success', async () => {
    for (const options of [{ warningFile: 'Document-1.pdf' }, { noConnectEffect: true }, { merged: true }]) {
        const page = await uploadPage(options);
        try {
            const runner = new MiFileFilingRunner(); (runner as any).timeoutMs = 200;
            await assert.rejects((runner as any).uploadDocuments(page, materialized(2, true)), (error: any) =>
                ['DOCUMENT_UPLOAD_WARNING', 'CONNECTED_FILING_NOT_CONFIRMED'].includes(error.code));
            assert.equal(await page.evaluate(() => Boolean((window as any).saved || (window as any).submitted)), false);
        } finally { await page.close(); }
    }
});

test('the final PDF manifest detects a lost or renamed row before Save Progress', async () => {
    const page = await uploadPage();
    try {
        const runner = new MiFileFilingRunner(async entry => {
            if (entry.details?.event === 'document_ready' && entry.details.documentNumber === 2) {
                await page.locator('#filing-0 input[name^="documentName_"]').fill('Unexpected change');
            }
        });
        await assert.rejects((runner as any).uploadDocuments(page, materialized(2)), (error: any) => error.code === 'UPLOAD_MANIFEST_MISMATCH');
        assert.equal(await page.evaluate(() => Boolean((window as any).saved || (window as any).submitted)), false);
    } finally { await page.close(); }
});

test('partial OneDrive materialization is cleaned up and reports its actual checkpoint', async () => {
    const drive = require('./oneDriveClient');
    const resolve = drive.resolveSharedDriveItem;
    const download = drive.downloadDriveItemBuffer;
    drive.resolveSharedDriveItem = async (url: string) => ({ driveId: 'qa', itemId: url });
    let calls = 0;
    drive.downloadDriveItemBuffer = async () => {
        if (++calls === 2) throw new Error('Simulated OneDrive disconnect');
        return testPdfFixture();
    };
    try {
        const job = { id: 'partial-materialization', mode: 'prepare',
            payload: { filingData: {relatedCivilAction:'none',moneyJudgmentRequested:false},
                documents: [filingDocument(0), filingDocument(1)] } } as FilingJobView;
        await assert.rejects(new MiFileFilingRunner().prepare(job), (error: any) =>
            error.checkpoint === 'materialize_documents' && /OneDrive disconnect/.test(error.message));
        assert.equal(fs.existsSync(path.join(directory, job.id, 'documents')), false);
    } finally {
        drive.resolveSharedDriveItem = resolve;
        drive.downloadDriveItemBuffer = download;
    }
});

test('long and duplicate source names materialize as distinct PDF filenames with a preserved extension', async () => {
    const drive = require('./oneDriveClient');
    const resolve = drive.resolveSharedDriveItem, download = drive.downloadDriveItemBuffer;
    drive.resolveSharedDriveItem = async () => ({ driveId: 'qa', itemId: 'qa' });
    drive.downloadDriveItemBuffer = async () => testPdfFixture();
    const target = path.join(directory, 'long-filenames'); fs.mkdirSync(target);
    try {
        const input = [0,1].map(index => ({ ...filingDocument(index), filename: 'x'.repeat(230) + '.PDF' }));
        const output = await (new MiFileFilingRunner() as any).materializeDocuments({ documents: input }, target);
        assert.notEqual(output[0].localPath, output[1].localPath);
        for (const file of output) {
            assert.equal(path.extname(file.localPath), '.pdf');
            assert.equal(path.dirname(file.localPath), target);
            assert.ok(path.basename(file.localPath).length < 200);
            const bytes = fs.readFileSync(file.localPath);
            assert.equal(file.fingerprint.bytes, bytes.length);
            assert.equal(file.fingerprint.sha256, createHash('sha256').update(bytes).digest('hex'));
        }
    } finally { drive.resolveSharedDriveItem = resolve; drive.downloadDriveItemBuffer = download; }
});

test('old queued snapshots with unknown answers or document relations are stopped before remote access', async () => {
    const runner = new MiFileFilingRunner();
    await assert.rejects(runner.prepare({mode:'submit'} as FilingJobView),
        (error:any)=>error.code==='UNSUPPORTED_JOB_MODE');
    const payload = {filingData:{relatedCivilAction:'none',moneyJudgmentRequested:false},documents:[filingDocument(0)]};
    for (const [invalid, code] of [
        [{...payload,filingData:{...payload.filingData,moneyJudgmentRequested:null}},'CASE_ANSWERS_UNCONFIRMED'],
        [{...payload,filingData:{...payload.filingData,relatedCivilAction:'unknown'}},'CASE_ANSWERS_UNCONFIRMED'],
        [{...payload,documents:[{...filingDocument(0),filingRelation:'unknown'}]},'DOCUMENT_RELATION_UNCONFIRMED'],
        [{...payload,filingData:{...payload.filingData,moneyJudgmentRequested:true,claimAmount:'0'}},'CLAIM_AMOUNT_UNCONFIRMED'],
        [{...payload,documents:[{...filingDocument(0),isPrimary:false},filingDocument(1,true)]},'CONNECTED_COMPLAINT_REQUIRED'],
    ] as const) {
        await assert.rejects(runner.prepare({mode:'prepare',payload:invalid} as FilingJobView),
            (error:any)=>error.code===code && error.checkpoint==='starting');
    }
});

test('partial case forms, uploads and uncertain saves require reconciliation without blocking later packages', async () => {
    const {getWorkflowDatabase}=require('./database') as typeof import('./database');
    const {buildFilingIntake}=require('./filingIntake') as typeof import('./filingIntake');
    const {MiFileFilingError}=require('./mifileFilingRunner') as typeof import('./mifileFilingRunner');
    const {runFilingWorker}=require('./filingWorker') as typeof import('./filingWorker');
    const db=getWorkflowDatabase();
    const checkpoints=['case_form','document_upload','save_progress','verify_saved_bundle','saved_unsubmitted'];
    const jobs=Array.from({length:checkpoints.length+1},(_,index)=>{
        const message={id:'worker-recovery-'+index,subject:'NEW LT FILING - QA '+index,
            from:{emailAddress:{address:'qa@example.com'}}};
        const parsed=buildFilingIntake(message,[]);
        parsed.intake!.manual=true;
        const email=db.registerEmail(message);
        const draft=db.createCaseDraft(email.id,parsed);
        db.addDocument({emailId:email.id,caseDraftId:draft,currentFilename:'Other.pdf',documentType:'Other',
            oneDriveUrl:'https://onedrive.example/other',status:'uploaded',uploadSource:'test'});
        const party={displayName:'Example Owner LLC',entityName:'Example Owner LLC',partyType:'entity',
            address1:'100 Main Street',city:'Lincoln Park',state:'MI',postalCode:'48146'};
        db.updateCaseDraft(draft,{courtName:'25th District Court',caseTitle:'Example Owner v Tenant',
            plaintiff:'Example Owner LLC',defendant:'Morgan Tenant'},undefined,{
            caseType:'LT - Landlord-Tenant Summary Proceedings',action:'Initiate a new case',
            relatedCivilAction:'none',moneyJudgmentRequested:false,claimAmount:'0.00',mailingRequested:true,
            plaintiff:party,defendants:[{...party,partyType:'person',entityName:null,displayName:'Morgan Tenant',firstName:'Morgan',lastName:'Tenant'}],
        });
        db.reviewCaseDraft(draft,'approve');
        return db.queueFilingJob(draft);
    });
    const previous=MiFileFilingRunner.prototype.prepare;
    const previousAuto=process.env.MIFILE_AUTO_PREPARE_ENABLED;
    process.env.MIFILE_AUTO_PREPARE_ENABLED='false';
    const controller=new AbortController();
    const processed:string[]=[];
    MiFileFilingRunner.prototype.prepare=async job=>{
        processed.push(job.id);
        const index=jobs.findIndex(item=>item.id===job.id);
        if(index<checkpoints.length) {
            if(checkpoints[index]==='verify_saved_bundle') db.appendFilingJobLog(job.id, {level:'info',checkpoint:'verify_saved_bundle',
                details:{event:'bundle_saved',externalBundleId:'fd2c1ad4-633d-429a-0166-08df32c555de',temporaryCaseNumber:'TEMP-QA'},message:'Saved bundle'});
            throw new MiFileFilingError('Simulated partial Unsubmitted bundle','MIFILE_AUTOMATION_FAILED',checkpoints[index]);
        }
        controller.abort();
        return {checkpoint:'saved_unsubmitted',externalBundleId:'qa-bundle',temporaryCaseNumber:'TEMP-QA',
            uploadedDocuments:1,mifileVersion:null,screenshotPath:null,url:'https://mifile.example/qa'};
    };
    try{
        await runFilingWorker({signal:controller.signal,pollIntervalMs:1000});
        assert.deepEqual(processed,jobs.map(job=>job.id));
        for(const job of jobs.slice(0,-1)) {
            assert.equal(db.getFilingJob(job.id)!.status,'reconciliation_required');
            assert.equal(db.getFilingJob(job.id)!.errorCode,'UNSUBMITTED_OUTCOME_UNKNOWN');
            assert.throws(()=>db.queueFilingJob(job.caseDraftId),/Approve the Draft/);
            assert.equal(db.listFilingJobs(job.caseDraftId).length,1);
        }
        const verifiedJob = db.getFilingJob(jobs[3].id)!;
        assert.equal(verifiedJob.externalBundleId,'fd2c1ad4-633d-429a-0166-08df32c555de');
        assert.equal(verifiedJob.temporaryCaseNumber,'TEMP-QA');
        assert.equal(db.getFilingJob(jobs[jobs.length-1].id)!.status,'prepared');
    }finally{
        controller.abort();
        MiFileFilingRunner.prototype.prepare=previous;
        if(previousAuto===undefined) delete process.env.MIFILE_AUTO_PREPARE_ENABLED;
        else process.env.MIFILE_AUTO_PREPARE_ENABLED=previousAuto;
    }
});

test('bundle references and filer checks reject lookalikes and never guess an ID from body text', () => {
    const id = 'fd2c1ad4-633d-429a-0166-08df32c555de';
    assert.equal(miFileBundleId(`https://mifile.courts.michigan.gov/filing/create/${id}`), id);
    for (const url of [`https://example.com/filing/create/${id}`, `https://mifile.courts.michigan.gov/filing/create/${id}?other=1`,
        'https://mifile.courts.michigan.gov/filing/create/not-a-bundle', 'Bundle Number: saved', `http://mifile.courts.michigan.gov/filing/create/${id}`])
        assert.equal(miFileBundleId(url), null);
    assert.ok(isRequiredMiFileFiler(' Devlin,  Adam (P72877) '));
    for (const label of ['Devlin, Adam', 'Devlin, Adam Jr (P72877)', 'Devlin, Adam (P11111)', 'Other Devlin, Adam (P72877)'])
        assert.equal(isRequiredMiFileFiler(label), false);
});

test('displayed money is parsed as exact cents, without guessing malformed or negative values', () => {
    for (const [value, cents] of [['$0.00', 0], ['$1,234.56', 123456], ['90', 9000], ['13.00', 1300]] as const)
        assert.equal(usdCents(value), cents);
    for (const value of ['', '-1.00', '1.2', '1,23.45', '1.234,56', 'NaN', '1e3', '$10.00 $20.00'])
        assert.equal(usdCents(value), null);
});

test('source fingerprints bind all PDFs and case fields to the preparation snapshot', () => {
    const payload = { documents: [filingDocument(0), filingDocument(1)], courtName: 'Court', filingData: {claimAmount:'1.00'} } as FilingPayload;
    const sources = payload.documents.map(document => ({documentId:document.id,sha256:'ab'.repeat(32),bytes:200}));
    const digest = preparationDigest(payload, sources);
    assert.equal(digest, preparationDigest(payload, [...sources].reverse()));
    assert.notEqual(digest, preparationDigest({...payload, courtName:'Other Court'}, sources));
    assert.notEqual(digest, preparationDigest(payload, sources.map((source,index)=>index ? source : {...source,sha256:'cd'.repeat(32)})));
    assert.throws(()=>preparationDigest(payload,[sources[0],sources[0]]));
    assert.throws(()=>preparationDigest(payload,sources.slice(1)));
});

async function savedBundlePage(options: {wrongName?:boolean;wrongType?:boolean;wrongAccount?:boolean;wrongFiler?:boolean;
    missingPdf?:boolean;extraPdf?:boolean;wrongParent?:boolean;warning?:boolean;serve?:boolean;quantity?:number} = {}) {
    const page = await browser.newPage();
    const id = 'fd2c1ad4-633d-429a-0166-08df32c555de';
    const rows = `<tbody id="filing-0"><tr><td></td><td>Case Initiation Form</td><td>1 KB</td><td>CASE INIT FORM</td><td><span class="glyphicon-ok">Uploaded</span></td><td>$0.00</td><td>View</td></tr></tbody>` +
        `<tbody id="filing-1"><tr><td></td><td><input name="documentName_1" value="${options.wrongName?'Wrong PDF':'Document 0'}"></td><td></td><td>1 KB</td><td><input id="selectFilingTypeInput_1" value="${options.wrongType?'Other':'Complaint for Possession Only'}"></td><td><span class="glyphicon-ok">Uploaded</span></td><td>$45.00</td><td>View</td></tr></tbody>` +
        (options.missingPdf?'':`<tbody id="child-${options.wrongParent?2:1}-0"><tr><td></td><td><input name="documentName_0" value="Document 1"></td><td></td><td>1 KB</td><td>CONNECTED FILING</td><td><span class="glyphicon-${options.warning?'alert':'ok'}" ${options.warning?'ng-show="parent.uploadStatus==WARNING"':''}>Uploaded</span></td><td>$0.00</td><td>View</td></tr></tbody>`) +
        (options.extraPdf?'<tbody id="filing-2"><tr><td>Unexpected PDF</td></tr></tbody>':'');
    const html = `<header>${options.wrongAccount?'other@example.com':'qa@example.com'}</header><main>MI Example County - 45th District Court TEMP-QA</main>` +
        `<input id="filer-input-selected" value="${options.wrongFiler?'Devlin, Adam (P00000)':'Devlin, Adam (P72877)'}">` +
        `<label><input type="checkbox" ${options.serve?'checked':''}>Serve Document</label><input type="checkbox" id="isEmergency">` +
        `<table id="documentTable"><caption>Filing documents</caption>${rows}</table>` +
        `<table><thead><tr><th>Additional Payment Type</th><th>Quantity</th><th>Fee</th><th>Actions</th></tr></thead><tbody><tr><td>Mailing Fee</td><td>${options.quantity??1}</td><td>$13.00</td><td>Remove</td></tr></tbody></table>` +
        `<button onclick="window.submitted=true">Submit</button><button onclick="window.next=true">Next</button>`;
    await page.route('**/*',route=>route.fulfill({contentType:'text/html',body:html}));
    await page.goto(`https://mifile.courts.michigan.gov/filing/create/${id}`);
    const receipts = [0,1].map(index=>({documentId:'doc-'+index,filename:`Document-${index}.pdf`,filingName:`Document ${index}`,
        filingType:index?'CONNECTED FILING':'Complaint for Possession Only',filingRelation:index?'connected_to_complaint':'separate',
        parentDocumentId:index?'doc-0':null,mifileRowId:index?'child-1-0':'filing-1'}));
    return {page,id,receipts,payload:{courtName:'MI Example County - 45th District Court'} as FilingPayload};
}

test('saved-bundle readback verifies account, filer, generated form and Connected PDFs without reaching checkout', async () => {
    const f = await savedBundlePage();
    try {
        await (new MiFileFilingRunner() as any).verifySavedBundle(f.page,f.payload,f.receipts,'qa@example.com',f.id,'TEMP-QA');
        const fees = await (new MiFileFilingRunner() as any).observeFees(f.page);
        assert.equal(fees.displayedSubtotalCents,5800);
        assert.equal(fees.checkoutTotalCents,null);
        assert.equal(fees.processingFeeCents,null);
        assert.equal(fees.lines.at(-1).label,'Mailing Fee');
        assert.equal(await f.page.evaluate(()=>Boolean((window as any).submitted||(window as any).next)),false);
    } finally {await f.page.close();}
});

test('persisted bundle mismatches stop for reconciliation; no missing PDF, warning or other filer is accepted', async () => {
    for (const options of [{wrongName:true},{wrongType:true},{wrongAccount:true},{wrongFiler:true},{missingPdf:true},
        {extraPdf:true},{wrongParent:true},{warning:true},{serve:true}]) {
        const f = await savedBundlePage(options);
        try {
            const runner = new MiFileFilingRunner(); (runner as any).timeoutMs=200; (runner as any).uploadTimeoutMs=200;
            await assert.rejects((runner as any).verifySavedBundle(f.page,f.payload,f.receipts,'qa@example.com',f.id,'TEMP-QA'),
                (error:any)=>error.code==='SAVED_BUNDLE_VERIFICATION_FAILED'&&error.checkpoint==='verify_saved_bundle');
            assert.equal(await f.page.evaluate(()=>Boolean((window as any).submitted||(window as any).next)),false);
        } finally {await f.page.close();}
    }
});

test('unfamiliar fee quantities do not produce a guessed subtotal', async () => {
    const f = await savedBundlePage({quantity:2});
    try {assert.equal((await (new MiFileFilingRunner() as any).observeFees(f.page)).displayedSubtotalCents,null);}
    finally {await f.page.close();}
});

test('preparation acknowledges only the known PII information notice and never accepts or removes other dialogs', async () => {
    const {dismissMifilePreparationNotice}=require('./mifileSession') as typeof import('./mifileSession');
    const page=await browser.newPage();
    try {
        await page.setContent('<div role="dialog">New terms and payment authorization<button onclick="window.accepted=true">OK</button></div>');
        await assert.rejects(dismissMifilePreparationNotice(page),/unexpected notice/);
        assert.equal(await page.getByRole('dialog').isVisible(),true);
        assert.equal(await page.evaluate(()=>Boolean((window as any).accepted)),false);
        await page.setContent('<div role="dialog">Do any of your public documents contain Protected Personal Identifying Information (PII)? Additional payment authorization<button onclick="window.accepted=true">OK</button></div>');
        await assert.rejects(dismissMifilePreparationNotice(page),/unexpected notice/);
        assert.equal(await page.getByRole('dialog').isVisible(),true);
        await page.setContent('<div role="dialog">Do any of your public documents contain Protected Personal Identifying Information (PII)?<button onclick="this.parentElement.remove()">OK</button></div>');
        await dismissMifilePreparationNotice(page);
        assert.equal(await page.getByRole('dialog').count(),0);
    } finally {await page.close();}
});

test('Save Progress acknowledges only its own success dialog and never an unrelated OK button',async()=>{
    const page=await browser.newPage();
    try {
        await page.setContent('<button onclick="document.getElementById(\'saved\').hidden=false">Save Progress</button>'+
            '<div role="dialog">Payment authorization<button onclick="window.wrongOk=true">OK</button></div>'+
            '<div role="dialog" id="saved" hidden>Your progress has been saved.<button onclick="window.savedOk=true;this.parentElement.hidden=true">OK</button></div>'+
            '<button onclick="window.submitted=true">Submit</button>');
        await (new MiFileFilingRunner() as any).saveProgress(page);
        assert.equal(await page.evaluate(()=>Boolean((window as any).savedOk)),true);
        assert.equal(await page.evaluate(()=>Boolean((window as any).wrongOk||(window as any).submitted)),false);
    } finally {await page.close();}
});

test('Complaint answers are read back from MiFILE controls before the case form can be saved',async()=>{
    const page=await browser.newPage();
    try {
        await page.setContent('<input id="claimAmount" value="0"><input type="radio" name="related" id="relatedCivilActions_0" checked><input type="radio" name="related" id="relatedCivilActions_1"><input type="checkbox" id="requestSecondMail" checked>');
        const payload={filingData:{relatedCivilAction:'none',moneyJudgmentRequested:false}};
        const runner=new MiFileFilingRunner();
        await (runner as any).verifyCaseAnswers(page.mainFrame(),payload);
        await page.locator('#claimAmount').fill('1.00');
        await assert.rejects((runner as any).verifyCaseAnswers(page.mainFrame(),payload),(error:any)=>error.code==='CASE_FORM_VALUES_MISMATCH');
        await page.locator('#claimAmount').fill('0'); await page.locator('#requestSecondMail').uncheck();
        await assert.rejects((runner as any).verifyCaseAnswers(page.mainFrame(),payload),(error:any)=>error.code==='CASE_FORM_VALUES_MISMATCH');
        await page.locator('#requestSecondMail').check();
        await page.locator('#claimAmount').fill('1,234.56');
        const supplemental={filingData:{relatedCivilAction:'none',moneyJudgmentRequested:true,claimAmount:'1234.56'}};
        await (runner as any).verifyCaseAnswers(page.mainFrame(),supplemental);
        await page.locator('#claimAmount').fill('1234.00');
        await assert.rejects((runner as any).verifyCaseAnswers(page.mainFrame(),supplemental),(error:any)=>error.code==='CASE_FORM_VALUES_MISMATCH');
    } finally {await page.close();}
});

test('release checks require matching evidence and account but never authorize payment or filing',()=>{
    const payload={documents:[filingDocument(0)],courtName:'Court'} as FilingPayload;
    const sources=[{documentId:'doc-0',sha256:'ab'.repeat(32),bytes:200}];
    const id='fd2c1ad4-633d-429a-0166-08df32c555de';
    const job={status:'prepared',payload,externalBundleId:id,temporaryCaseNumber:'TEMP-QA',result:{
        url:`https://mifile.courts.michigan.gov/filing/create/${id}`,
        documentManifest:[{documentId:'doc-0',filingName:'Document 0',filingType:'Complaint for Possession Only',filingRelation:'separate',parentDocumentId:null}],
        savedBundleEvidence:{version:1,verifiedAt:new Date().toISOString(),sourcePdfCount:1,generatedPdfCount:1,
            courtName:'Court',connectedPdfCount:0,
            externalBundleId:id,temporaryCaseNumber:'TEMP-QA',filer:'Devlin, Adam (P72877)',accountEmail:'qa@example.com',
            sources,packageDigest:preparationDigest(payload,sources),fees:{source:'unsubmitted_upload',currency:'USD',displayedSubtotalCents:5800}},
    }} as unknown as FilingJobView;
    const account={username:'qa@example.com',accountEnvironment:'test',productionConfirmed:false};
    const result=filingReleaseChecks(job,account);
    assert.equal(result.savedBundleVerified,true);
    assert.equal(result.sourceSnapshotPinned,true);
    assert.equal(result.sameAccount,true);
    assert.equal(result.primaryAccountConfirmed,false);
    assert.equal(result.finalActionsEnabled,false);
    assert.equal(result.checkoutVerified,false);
    assert.equal(result.currentSourceContentVerified,false);
    assert.equal(filingReleaseChecks(job,{...account,username:'primary@example.com'}).sameAccount,false);
    assert.equal(filingReleaseChecks({...job,result:{}},account).savedBundleVerified,false);
    assert.equal(filingReleaseChecks({...job,payload:{...payload,courtName:'Changed Court'}},account).savedBundleVerified,false);
});
