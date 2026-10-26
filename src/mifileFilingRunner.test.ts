import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { after, before } from 'node:test';
import { chromium, Browser, Page } from 'playwright';
import type { FilingDocumentPayload, FilingJobView } from './database';
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
    const checkpoints=['case_form','document_upload','save_progress','saved_unsubmitted'];
    const jobs=[0,1,2,3,4].map(index=>{
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
        if(index<checkpoints.length) throw new MiFileFilingError('Simulated partial Unsubmitted bundle','MIFILE_AUTOMATION_FAILED',checkpoints[index]);
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
        assert.equal(db.getFilingJob(jobs[4].id)!.status,'prepared');
    }finally{
        controller.abort();
        MiFileFilingRunner.prototype.prepare=previous;
        if(previousAuto===undefined) delete process.env.MIFILE_AUTO_PREPARE_ENABLED;
        else process.env.MIFILE_AUTO_PREPARE_ENABLED=previousAuto;
    }
});
