import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { chromium } from 'playwright';
import { testPdfFixture, testComplaintFormFixture } from './testPdfFixture';
import { CURRENT_COMPLAINT_EXTRACTOR_VERSION } from './complaintExtractor';

async function main() {
    const originalCwd = process.cwd();
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'admin-intake-smoke-'));
    const screenshots = path.join(originalCwd, 'output', 'intake-qa');
    fs.mkdirSync(screenshots, { recursive: true });
    process.chdir(directory);
    Object.assign(process.env, {
        TENANT_ID: '11111111-1111-1111-1111-111111111111', CLIENT_ID: 'test-client', CLIENT_SECRET: 'test-secret',
        USER_EMAIL: 'intake@example.com', ONEDRIVE_ROOT_SHARE_URL: 'https://onedrive.example/root',
        WORKFLOW_DB_PATH: path.join(directory, 'workflow.sqlite'), ADMIN_SYNC_ENABLED: 'false',
        MIFILE_FILING_DEBUG_DIR: path.join(directory, 'mifile-debug'),
        ADMIN_USERNAME: 'qa', ADMIN_PASSWORD: 'qa-admin-only',
        MIFILE_USER: 'alternate@example.com', MIFILE_PASSWORD: 'qa-mifile-only',
        MIFILE_CREDENTIALS_KEY: 'ab'.repeat(32), NODE_ENV: 'test',
    });
    const { getWorkflowDatabase } = require('./database') as typeof import('./database');
    const { buildFilingIntake } = require('./filingIntake') as typeof import('./filingIntake');
    const db = getWorkflowDatabase();
    const storedFiles = new Map<string, Buffer>();
    const drive = require('./oneDriveClient');
    let rejectUpload = false;
    drive.ensureIntakeFolder = async () => ({ driveId: 'fixture-drive', itemId: 'fixture-folder' });
    drive.uploadFileBufferToFolder = async (_driveId: string, _folder: string, name: string, buffer: Buffer) => {
        if(rejectUpload) throw new Error('Simulated OneDrive upload failure');
        storedFiles.set(name, buffer);
        return { driveId: 'fixture-drive', itemId: name, fileName: name };
    };
    drive.createFileLink = async (_driveId: string, itemId: string) => `https://onedrive.example/${encodeURIComponent(itemId)}`;
    drive.resolveSharedDriveItem = async (url: string) => ({ driveId: 'fixture-drive', itemId: decodeURIComponent(url.split('/').pop()!), parentItemId: 'fixture-folder', fileName: 'Advice.pdf' });
    drive.downloadDriveItemBuffer = async (_driveId: string, itemId: string) => storedFiles.get(itemId);
    drive.replaceDriveItemContent = async (_driveId:string,itemId:string,buffer:Buffer) => { storedFiles.set(itemId,buffer); };
    const session = require('./mifileSession');
    let signInTests = 0;
    session.testMiFileCredentials = async (credentials: { password: string }) => {
        signInTests++;
        assert.equal(credentials.password, 'new-account-secret');
    };
    const message = { id: 'intake-empty', subject: 'NEW LT FILING - Example Property v Tenant',
        receivedDateTime: '2026-09-08T09:00:00Z', from: { emailAddress: { address: 'ajd@devlinlawpllc.com' } } };
    const email = db.registerEmail(message);
    const draftId = db.createCaseDraft(email.id, buildFilingIntake(message, []));
    db.markEmailProcessed(email.id);
    db.refreshCaseDraftValidation(draftId);
    const ruleCourt='MI Example County - 29th District Court';
    const ruleMessage={id:'court-rule-example',subject:'NEW LT FILING - Court rules example'};
    const ruleEmail=db.registerEmail(ruleMessage);
    db.createCaseDraft(ruleEmail.id,{...buildFilingIntake(ruleMessage,[]),courtName:ruleCourt});
    db.markEmailProcessed(ruleEmail.id);
    const notificationMessage = {
        id: 'filed-notification',
        subject: 'MiFILE - Document Filed 26-00001-LT, EXAMPLE OWNER V TENANT',
        receivedDateTime: '2026-09-08T10:00:00Z',
        from: { emailAddress: { address: 'info@truefiling.com' } },
    };
    const notificationEmail = db.registerEmail(notificationMessage);
    const notificationParsed = buildFilingIntake(notificationMessage, []);
    Object.assign(notificationParsed, {
        courtName: 'MI Example County - 25th District Court',
        caseTitle: 'EXAMPLE OWNER V TENANT',
        plaintiff: 'EXAMPLE OWNER',
        defendant: 'TENANT',
    });
    const notificationDraftId = db.createCaseDraft(notificationEmail.id, notificationParsed);
    db.addDocument({
        emailId: notificationEmail.id,
        caseDraftId: notificationDraftId,
        originalFilename: 'Filed Complaint.pdf',
        currentFilename: 'Filed Complaint.pdf',
        oneDriveUrl: 'https://onedrive.example/Filed%20Complaint.pdf',
        mimeType: 'application/pdf',
        fileSize: 1024,
        documentType: 'Complaint for Possession Only',
        uploadSource: 'processing_report',
        status: 'uploaded',
    });
    db.markEmailProcessed(notificationEmail.id);
    db.refreshCaseDraftValidation(notificationDraftId);
    const { createAdminServer } = require('./adminServer') as typeof import('./adminServer');
    const server = createAdminServer(0, { handleSignals: false, closeDatabaseOnShutdown: false });
    await once(server, 'listening');
    const port = (server.address() as { port: number }).port;
    const url = `http://127.0.0.1:${port}`;
    const browser = await chromium.launch({ headless: true });
    const context = await browser.newContext();
    await context.route('**/*', route => {
        if (route.request().url().startsWith(url)) return route.continue();
        return route.abort();
    });
    const page = await context.newPage();
    const clickDocumentTool = async (id: string) => {
        const menu=page.locator('#draftDocumentTools');
        if (!await menu.evaluate(element=>(element as HTMLDetailsElement).open)) await menu.locator('summary').click();
        await page.locator('#'+id).click();
    };
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    try {
        await page.setViewportSize({ width: 1440, height: 1000 });
        await page.goto(url);
        await page.locator('#loginForm').waitFor();
        assert.ok(page.url().endsWith('/login'));
        await page.locator('#username').fill('qa');
        await page.locator('#password').fill('wrong-password');
        await page.locator('#signIn').click();
        await page.waitForFunction(() => document.getElementById('error')?.textContent === 'Incorrect username or password.');
        assert.equal(await page.locator('#username').inputValue(), 'qa');
        await page.screenshot({ path: path.join(screenshots, 'login-desktop.png'), fullPage: true });
        await page.setViewportSize({ width: 390, height: 844 });
        await page.screenshot({ path: path.join(screenshots, 'login-mobile.png'), fullPage: true });
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
        await page.locator('#password').fill('qa-admin-only');
        await page.locator('#signIn').click();
        await page.waitForURL(url + '/');
        await page.setViewportSize({ width: 1440, height: 1000 });
        await page.locator('#settingsTab').click();
        await page.waitForFunction(() => document.getElementById('intakeMailbox')?.textContent === 'intake@example.com');
        await page.locator('#courtRuleCourt').fill(ruleCourt);
        await page.locator('#courtRuleRelation').selectOption('connected_to_complaint');
        await page.locator('#courtRuleNotes').fill('Attorney-confirmed example rule');
        await page.locator('#courtRuleConfirmed').check();
        await page.locator('#courtRuleSave').click();
        await page.waitForFunction(() => document.getElementById('courtRuleMessage')?.textContent==='Court rule saved.');
        const firstRule=db.listCourtFilingRules()[0];
        assert.equal(firstRule.relation,'connected_to_complaint');
        const ruleRow=page.locator('[data-court-rule="'+firstRule.id+'"]');
        await ruleRow.locator('[data-rule-relation]').selectOption('separate');
        page.once('dialog',dialog=>dialog.accept());
        await ruleRow.locator('[data-save-rule]').click();
        await page.waitForFunction(() => document.getElementById('courtRuleMessage')?.textContent?.includes('New rule version saved'));
        assert.equal(db.listCourtFilingRules(true).length,2);
        assert.equal(db.listCourtFilingRules()[0].relation,'separate');
        await page.locator('.court-rules-section').screenshot({path:path.join(screenshots,'court-rules-desktop.png')});
        await page.setViewportSize({width:390,height:844});
        assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),true);
        await page.locator('.court-rules-section').screenshot({path:path.join(screenshots,'court-rules-mobile.png')});
        await page.setViewportSize({width:1440,height:1000});
        const currentRule=db.listCourtFilingRules()[0];
        page.once('dialog',dialog=>dialog.accept());
        await page.locator('[data-court-rule="'+currentRule.id+'"] [data-disable-rule]').click();
        await page.waitForFunction(()=>document.getElementById('courtRuleList')?.textContent?.includes('No court filing rules configured'));
        await page.locator('#libraryFile').setInputFiles({ name: 'Standard Advice.pdf', mimeType: 'application/pdf', buffer: testPdfFixture('Advice of Rights and Information') });
        await page.locator('#libraryConfirmed').check();
        await page.locator('#libraryUploadBtn').click();
        await page.waitForFunction(() => document.getElementById('libraryList')?.textContent?.includes('Standard Advice.pdf'));
        await page.locator('#libraryRole').selectOption('local');
        await page.locator('#libraryCourt').fill('MI Example County - 25th District Court');
        await page.locator('#libraryFile').setInputFiles({ name: 'District Local.pdf', mimeType: 'application/pdf', buffer: testPdfFixture('Local Rental and Housing Information') });
        await page.locator('#libraryConfirmed').check();
        await page.locator('#libraryUploadBtn').click();
        await page.waitForFunction(() => document.getElementById('libraryList')?.textContent?.includes('District Local.pdf'));
        assert.equal(db.listLibraryForms().filter(form => form.active).length, 2);
        const libraryPdf = await context.request.get(`${url}/api/form-library/${db.listLibraryForms()[0].id}/content`);
        assert.equal(libraryPdf.status(), 200);
        assert.ok((await libraryPdf.body()).includes(Buffer.from('%PDF-')));
        await page.locator('#miFileAccountEmail').fill('primary@example.com');
        await page.locator('#miFileAccountPassword').fill('new-account-secret');
        await page.locator('#miFileAccountType').selectOption('production');
        await page.locator('#miFilePrimaryConfirmation').check();
        await page.locator('#miFileAccountSave').click();
        await page.waitForFunction(() => document.getElementById('settingsMessage')?.textContent === 'Sign-in verified. Account saved.');
        assert.equal(signInTests, 1);
        assert.equal(await page.locator('#miFileAccountPassword').inputValue(), '');
        const settingsResponse = await context.request.get(`${url}/api/settings`);
        const settings = await settingsResponse.json();
        assert.equal(settings.account.username, 'primary@example.com');
        assert.ok(!JSON.stringify(settings).includes('new-account-secret'));
        const blocked = await context.request.post(`${url}/api/settings/mifile`, {
            headers: { Origin: 'https://foreign.example', 'X-Admin-Action': 'account-settings' },
            data: { username: 'attacker@example.com', password: 'bad', accountEnvironment: 'test' },
        });
        assert.equal(blocked.status(), 403);
        assert.equal(signInTests, 1);
        await page.screenshot({ path: path.join(screenshots, 'settings-desktop.png'), fullPage: true });
        await page.setViewportSize({ width: 390, height: 844 });
        await page.screenshot({ path: path.join(screenshots, 'settings-mobile.png'), fullPage: true });
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), true);
        await page.setViewportSize({ width: 1440, height: 1000 });
        await page.locator('#draftsTab').click();
        await page.locator(`[data-open-draft="${draftId}"]`).click();
        await page.locator('#draftAddDocumentBtn').click();
        await page.locator('#draftDocumentFileInput').setInputFiles({ name: 'scan001.pdf', mimeType: 'application/pdf', buffer: testPdfFixture('Advice of Rights') });
        await page.waitForFunction(() => document.getElementById('draftDocumentSelect')?.textContent?.includes('scan001'));
        assert.equal(db.getDraftDetail(draftId)?.documents.length, 1);
        const added = db.getDraftDetail(draftId)!.documents[0];
        assert.equal(added.packageRole, 'advice');
        assert.equal(added.recognition?.source, 'content');
        assert.ok(added.oneDriveUrl);
        const response = await context.request.get(`${url}/api/documents/${added.id}/content`);
        assert.equal(response.status(), 200);
        assert.ok((await response.body()).includes(Buffer.from('%PDF-')));
        const canvas = page.frameLocator('#draftPdfViewer iframe').locator('canvas');
        await canvas.waitFor({ state: 'visible' });
        assert.ok(await canvas.evaluate(element => {
            const canvas = element as HTMLCanvasElement;
            const data = canvas.getContext('2d')!.getImageData(0, 0, canvas.width, canvas.height).data;
            let ink = 0;
            for (let index = 0; index < data.length; index += 4) if (data[index] < 180 && data[index + 3] > 0) ink++;
            return ink > 20;
        }), 'PDF canvas must contain rendered document content');
        const zoomControl = page.frameLocator('#draftPdfViewer iframe').locator('#zoom');
        await zoomControl.selectOption('1.5');
        await page.evaluate(() => (window as any).renderDraftWorkspace());
        assert.equal(await zoomControl.inputValue(), '1.5', 'Live updates must preserve PDF navigation');
        await zoomControl.selectOption('fit');
        await page.screenshot({ path: path.join(screenshots, 'draft-desktop.png'), fullPage: true });
        await page.setViewportSize({ width: 390, height: 844 });
        const preview = page.frames().find(frame => frame.url().includes('/preview'))!;
        await preview.waitForFunction(() => {
            const canvas = document.querySelector('canvas');
            return canvas && canvas.getBoundingClientRect().width <= document.documentElement.clientWidth;
        });
        await page.screenshot({ path: path.join(screenshots, 'draft-mobile.png'), fullPage: true });
        const linkBox = await page.locator('#draftOneDriveLink').boundingBox();
        const viewerBox = await page.locator('#draftPdfViewer').boundingBox();
        assert.ok(linkBox && viewerBox && linkBox.y + linkBox.height <= viewerBox.y + 1);
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), true);
        await page.setViewportSize({ width: 1440, height: 1000 });
        let releaseRefresh!: () => void;
        let refreshRequested!: () => void;
        const refreshGate = new Promise<void>(resolve => { releaseRefresh = resolve; });
        const requested = new Promise<void>(resolve => { refreshRequested = resolve; });
        let pauseRefresh = true;
        const draftRoute = url + '/api/drafts/' + draftId;
        await context.route(draftRoute, async route => {
            if (pauseRefresh && route.request().method() === 'GET') {
                pauseRefresh = false;
                refreshRequested();
                await refreshGate;
            }
            await route.continue();
        });
        await page.locator('#draftDataTab').click();
        const delayedRefresh = page.evaluate(() => (window as any).refreshDraftFilingState());
        await requested;
        await page.locator('[data-draft-field="courtName"]').fill('MI Example County - 25th District Court');
        releaseRefresh();
        await delayedRefresh;
        await context.unroute(draftRoute);
        assert.equal(await page.locator('[data-draft-field="courtName"]').inputValue(),'MI Example County - 25th District Court');
        assert.equal(await page.locator('#draftSaveBtn').isEnabled(),true,'A stale refresh must not discard an edit started in flight');
        await page.locator('#draftSaveBtn').click();
        await page.waitForFunction(() => document.getElementById('draftDocumentSelect')?.textContent?.includes('Local'));
        assert.equal(db.getDraftDetail(draftId)!.documents.length, 2);
        const local = db.getDraftDetail(draftId)!.documents.find(doc => doc.formTemplate?.role === 'local')!;
        await page.locator('#draftDocumentSelect').selectOption(local.id);
        assert.equal(await page.locator('#draftReplaceDocumentBtn').isDisabled(), true);
        const applied = page.waitForResponse(response => response.url().endsWith('/standard-forms') && response.status() === 200);
        await clickDocumentTool('draftLibraryBtn');
        await applied;
        assert.equal(db.getDraftDetail(draftId)!.documents.length, 2);
        page.once('dialog', dialog => dialog.accept());
        const removed = page.waitForResponse(response => response.url().includes('/documents/') && response.request().method() === 'DELETE' && response.status() === 200);
        await clickDocumentTool('draftRemoveFormBtn');
        await removed;
        assert.equal(db.getDraftDetail(draftId)!.documents.length, 1);
        assert.equal(storedFiles.size, 2, 'Removing a library document must not delete its OneDrive copy');
        await page.locator('#draftAddDocumentBtn').click();
        await page.locator('#draftDocumentFileInput').setInputFiles({ name:'Complaint.pdf',mimeType:'application/pdf',buffer:testComplaintFormFixture() });
        await page.waitForFunction(() => document.querySelector('.draft-source-summary')?.textContent?.includes('PDF form fields'));
        let extracted=db.getDraftDetail(draftId)!.caseDraft!;
        assert.equal(await page.locator('[data-filing-field="mailingRequested"]').isDisabled(),true);
        assert.equal(extracted.complaintExtraction?.extractorVersion,CURRENT_COMPLAINT_EXTRACTOR_VERSION);
        assert.equal(extracted.filingData.defendants[0].postalCode,'48146');
        assert.equal(extracted.filingData.claimAmount,'1991.50');
        assert.ok(!extracted.validationIssues.some(issue=>issue.field==='complaintExtraction'));
        assert.ok(!extracted.validationIssues.some(issue=>issue.message.startsWith('No PDF attachments were received.')));
        assert.equal(extracted.filingData.plaintiff.address1,'30850 Telegraph Rd Ste 250');
        assert.equal(extracted.filingData.plaintiff.email,'ajd@devlinlawpllc.com');
        await page.locator('#draftDataTab').click();
        const defaultAddress=page.locator('[data-party-role="plaintiff"] [data-party-field="address1"]');
        assert.match(await defaultAddress.locator('xpath=..').textContent() || '',/Attorney rule/);
        // An intentional manual blank must remain a real correction, not refill from policy.
        await defaultAddress.fill('');
        const blankSaved=page.waitForResponse(response=>response.url().endsWith('/api/drafts/'+draftId) && response.request().method()==='PATCH' && response.status()===200);
        await page.locator('#draftSaveBtn').click();
        await blankSaved;
        await page.waitForFunction(()=>document.getElementById('draftSaveBtn')?.hasAttribute('disabled')===true);
        extracted=db.getDraftDetail(draftId)!.caseDraft!;
        const addressIssue = extracted.validationIssues.findIndex(issue => issue.field === 'filingData.plaintiff.address1');
        assert.ok(addressIssue >= 0, 'Missing Plaintiff street address must point to that exact field');
        await page.locator('#draftReviewTab').click();
        await page.locator('[data-review-issue="' + addressIssue + '"]').click();
        const plaintiffAddress = page.locator('[data-party-role="plaintiff"] [data-party-field="address1"]');
        await page.waitForFunction(()=>document.querySelector('[data-party-role="plaintiff"] [data-party-field="address1"]')===document.activeElement);
        const focusedBeforeRefresh = await plaintiffAddress.elementHandle();
        await page.waitForFunction(element => !element?.isConnected, focusedBeforeRefresh);
        assert.equal(await plaintiffAddress.evaluate(element => element === document.activeElement), true);
        assert.equal(await plaintiffAddress.getAttribute('aria-invalid'), 'true');
        assert.equal(await page.locator('#draftApproveBtn').isDisabled(), true);
        await plaintiffAddress.fill('201 Main Street');
        await page.locator('[data-party-role="plaintiff"] [data-party-field="city"]').fill('Lincoln Park');
        await page.locator('[data-party-role="plaintiff"] [data-party-field="state"]').fill('MI');
        await page.locator('[data-party-role="plaintiff"] [data-party-field="postalCode"]').fill('48146');
        const partyExtras=page.locator('[data-disclosure="plaintiff-0"]');
        await partyExtras.locator('summary').click();
        await partyExtras.locator('[data-party-field="phone"]').fill('2485550101');
        // A background extraction finishes after the user starts editing a different field.
        const newerExtraction=structuredClone(extracted.complaintExtraction!);
        newerExtraction.data.defendants![0].phone='248-555-0177';
        db.applyComplaintExtraction(draftId,extracted.primaryDocumentId!,newerExtraction);
        assert.equal(await page.locator('[data-party-role="plaintiff"] [data-party-field="firstName"]').isHidden(),true);
        let releaseSave!:()=>void;
        let saveRequested!:()=>void;
        const saveGate=new Promise<void>(resolve=>{releaseSave=resolve;});
        const saving=new Promise<void>(resolve=>{saveRequested=resolve;});
        await context.route(draftRoute,async route=>{
            if(route.request().method()==='PATCH'){saveRequested();await saveGate;}
            await route.continue();
        });
        await page.locator('#draftSaveBtn').click();
        await saving;
        assert.equal(await plaintiffAddress.isDisabled(),true,'Inputs are locked while their snapshot is being saved');
        assert.equal(await page.locator('#closeDraftBtn').isDisabled(),true);
        releaseSave();
        await page.waitForFunction(() => !document.querySelector('[data-review-field="filingData.plaintiff.address1"]')?.hasAttribute('aria-invalid'));
        await context.unroute(draftRoute);
        assert.equal(db.getDraftDetail(draftId)!.caseDraft!.filingData.plaintiff!.phone,'2485550101');
        assert.equal(db.getDraftDetail(draftId)!.caseDraft!.filingData.defendants[0].phone,'248-555-0177','Saving an older screen must retain fresh automatic values in untouched fields');
        assert.equal(await partyExtras.evaluate(element=>(element as HTMLDetailsElement).open),true);
        assert.equal(await page.locator('#draftDataTab').getAttribute('aria-selected'),'true');
        assert.match(await plaintiffAddress.locator('..').innerText(), /Manual/);
        await page.locator('[data-complaint-source]').first().click();
        assert.equal(await page.locator('#draftDocumentSelect').inputValue(), extracted.primaryDocumentId);
        await page.frameLocator('#draftPdfViewer iframe').locator('canvas').waitFor({state:'visible'});
        await page.frameLocator('#draftPdfViewer iframe').locator('#message').waitFor({state:'hidden'});
        await page.screenshot({path:path.join(screenshots,'complaint-fields-desktop.png'),fullPage:true});
        await page.setViewportSize({width:390,height:844});
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1),true);
        await page.locator('#draftDocumentTools summary').click();
        assert.equal(await page.locator('.draft-source-actions button').evaluateAll(buttons => buttons.every(button => {
            const rect=button.getBoundingClientRect();
            return rect.left>=0 && rect.right<=window.innerWidth && button.clientWidth>=button.scrollWidth;
        })),true,'Every mobile document action must fit its panel');
        await page.locator('#draftDocumentTools summary').click();
        const complaintPreview=page.frames().find(frame=>frame.url().includes('/preview'))!;
        await complaintPreview.waitForFunction(() => {
            const canvas=document.querySelector('canvas');
            return canvas && canvas.getBoundingClientRect().width<=document.documentElement.clientWidth;
        });
        await page.screenshot({path:path.join(screenshots,'complaint-fields-mobile.png'),fullPage:true});
        await page.locator('[data-draft-mobile-mode="fields"]').click();
        await page.screenshot({path:path.join(screenshots,'draft-review-mobile.png'),fullPage:true});
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1),true);
        await page.setViewportSize({width:1440,height:1000});

        for (const [name, text] of [
            ['Summons.pdf', 'SUMMONS, LANDLORD-TENANT/LAND CONTRACT'],
            ['Request.pdf', 'REQUEST FOR COURT MAILING AND RECORD'],
            ['Demand.pdf', 'DEMAND FOR POSSESSION NONPAYMENT OF RENT'],
        ]) {
            const upload = page.waitForResponse(response => response.url().endsWith('/documents') && response.request().method() === 'POST');
            await page.locator('#draftAddDocumentBtn').click();
            await page.locator('#draftDocumentFileInput').setInputFiles({name,mimeType:'application/pdf',buffer:testPdfFixture(text)});
            assert.equal((await upload).status(),201);
            await page.waitForFunction(filename => document.getElementById('draftDocumentSelect')?.textContent?.includes(filename.replace('.pdf','')), name);
        }
        const ancillary = db.getDraftDetail(draftId)!.documents.find(document => document.packageRole === 'ancillary')!;
        assert.ok(ancillary);
        assert.equal(ancillary.filingRelation,'separate');
        assert.equal(ancillary.filingRelationSource,'court_rule');
        await page.locator('#draftDocumentsTab').click();
        await page.locator('[data-disclosure="document-' + ancillary.id + '"] summary').click();
        await page.evaluate(()=>(window as any).renderDraftWorkspace());
        assert.equal(await page.locator('#draftDocumentsTab').getAttribute('aria-selected'),'true');
        assert.equal(await page.locator('[data-disclosure="document-' + ancillary.id + '"]').evaluate(element=>(element as HTMLDetailsElement).open),true);
        const ancillaryRow = page.locator('[data-draft-document-id="' + ancillary.id + '"]');
        await ancillaryRow.locator('[data-document-field="filingRelation"]').selectOption('unknown');
        const unknownSaved=page.waitForResponse(response=>response.url().endsWith('/api/drafts/'+draftId) && response.request().method()==='PATCH' && response.status()===200);
        await page.locator('#draftSaveBtn').click();
        await unknownSaved;
        assert.ok(db.getDraftDetail(draftId)!.caseDraft!.validationIssues.some(issue=>issue.field==='document.'+ancillary.id && issue.severity==='error'));
        assert.equal(await page.locator('#draftApproveBtn').isDisabled(),true);
        await ancillaryRow.locator('[data-document-field="filingRelation"]').selectOption('separate');
        // Explicit review also covers filename-only recognition in a small synthetic fixture.
        await ancillaryRow.locator('[data-document-field="filingType"]').fill('Other');
        await page.locator('#draftSaveBtn').click();
        await page.waitForFunction(() => document.getElementById('draftSaveBtn')?.hasAttribute('disabled') === true);
        const complete = db.getDraftDetail(draftId)!;
        assert.equal(complete.documents.length, 6);
        assert.deepEqual(complete.caseDraft!.validationIssues, []);
        await ancillaryRow.locator('[data-document-field="filingRelation"]').selectOption('connected_to_complaint');
        await page.locator('#draftSaveBtn').click();
        await page.waitForFunction(() => document.getElementById('draftSaveBtn')?.hasAttribute('disabled') === true);
        await page.locator('#draftReviewTab').click();
        assert.match(await page.locator('#draftReviewPane .draft-overview-file').filter({hasText:'Ancillary'}).innerText(),/Connected to Complaint/);
        await page.locator('#draftDocumentsTab').click();
        await ancillaryRow.locator('[data-document-field="filingRelation"]').selectOption('separate');
        await page.locator('#draftSaveBtn').click();
        await page.waitForFunction(() => document.getElementById('draftSaveBtn')?.hasAttribute('disabled') === true);
        await page.locator('#draftReviewTab').click();
        assert.equal(db.getDraftDetail(draftId)!.caseDraft!.reviewedAt,null);
        assert.equal(await page.locator('#draftReviewTab').getAttribute('aria-selected'),'true');
        await page.frameLocator('#draftPdfViewer iframe').locator('canvas').waitFor({state:'visible'});
        await page.frameLocator('#draftPdfViewer iframe').locator('#message').waitFor({state:'hidden'});
        await page.screenshot({path:path.join(screenshots,'draft-guided-review-desktop.png'),fullPage:true});
        await page.setViewportSize({width:390,height:844});
        await page.locator('[data-draft-mobile-mode="fields"]').click();
        await page.screenshot({path:path.join(screenshots,'draft-guided-review-mobile.png'),fullPage:true});
        assert.equal(await page.locator('#queueTab').isVisible(),true,'Main navigation remains available in the mobile editor');
        assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),true);
        assert.equal(await page.locator('#draftPrepareBtn').evaluate(element=>element.getBoundingClientRect().bottom<=innerHeight),true,'The primary action stays inside the mobile viewport');
        await page.setViewportSize({width:1440,height:1000});
        // Cancel is side-effect free; a second click approves and queues together.
        await page.locator('#draftPrepareBtn').click();
        await page.locator('#draftConfirmDialog').waitFor({state:'visible'});
        assert.match(await page.locator('#draftConfirmMessage').innerText(),/No payment or court submission/);
        await page.locator('#draftConfirmDialog [value="cancel"]').click();
        assert.equal(db.getDraftDetail(draftId)!.caseDraft!.reviewedAt,null);
        assert.equal(db.listFilingJobs(draftId).length,0);
        await page.locator('#draftPrepareBtn').click();
        await page.locator('#draftConfirmAccept').click();
        await page.waitForFunction(() => document.getElementById('draftFilingJobPanel')?.textContent?.includes('Queued'));
        await page.waitForFunction(() => !document.getElementById('draftPrepareBtn')?.classList.contains('loading'));
        const job = db.listFilingJobs(draftId)[0];
        assert.equal(job.payload!.documents.length,6,'Preparation must contain the full package, not just its Complaint');
        assert.equal(job.mode,'prepare');
        assert.equal(await page.locator('#draftPrepareBtn').innerText(),'View progress');
        await page.locator('#draftPrepareBtn').click();
        assert.equal(db.listFilingJobs(draftId).length,1);
        assert.equal((await context.request.post(`${url}/api/drafts/${draftId}/filing-jobs`,{headers:{Origin:url},data:{mode:'prepare'}})).status(),409);
        assert.equal(db.listFilingJobs(draftId).length,1);
        await page.evaluate(() => {
            (window as any).showToast('Previous success');
            (window as any).showToast('Latest success');
            (window as any).showToast('Example error','error');
        });
        assert.equal(await page.locator('#toastRegion .toast').count(),2);
        assert.equal(await page.locator('#toastRegion').innerText().then(text=>text.includes('Previous success')),false);
        await page.locator('[aria-label="Dismiss notification"]').first().click();
        assert.equal(await page.locator('#toastRegion .toast').count(),1);
        await page.locator('[aria-label="Dismiss notification"]').click();
        assert.equal(db.claimNextFilingJob()!.id,job.id);
        for (const document of job.payload!.documents.slice(0,2)) db.appendFilingJobLog(job.id,{
            level:'info',checkpoint:'document_upload',message:'Simulated verified upload.',details:{event:'document_ready',documentId:document.id},
        });
        db.appendFilingJobLog(job.id,{level:'info',checkpoint:'document_upload',message:'Simulated active upload.',
            details:{event:'document_started',documentId:job.payload!.documents[2].id}});
        await page.evaluate(() => (window as any).refreshDraftFilingState());
        assert.match(await page.locator('#draftFilingJobPanel').innerText(),/Verified PDFs: 2 \/ 6/);
        assert.match(await page.locator('#draftNextActionTitle').innerText(),/Uploading PDFs \(2 \/ 6\)/);
        await page.screenshot({path:path.join(screenshots,'draft-mifile-progress.png'),fullPage:true});
        await page.setViewportSize({width:390,height:844});
        await page.locator('[data-draft-mobile-mode="fields"]').click();
        await page.locator('[data-upload-checklist] summary').click();
        assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),true);
        assert.equal(await page.locator('#draftPrepareBtn').evaluate(element=>element.getBoundingClientRect().bottom<=innerHeight),true);
        await page.screenshot({path:path.join(screenshots,'draft-mifile-progress-mobile.png'),fullPage:true});
        await page.setViewportSize({width:1440,height:1000});
        db.appendFilingJobLog(job.id,{level:'info',checkpoint:'save_progress',message:'Simulated interrupted save; no remote call was made.'});
        assert.equal(db.recoverInterruptedFilingJobs(),1);
        await page.evaluate(() => (window as any).refreshDraftFilingState());
        await page.locator('[data-reconcile-filing-job="found"]').waitFor();
        assert.equal(await page.locator('#draftPrepareBtn').innerText(),'Check result');
        const incompleteConfirmation=await context.request.post(`${url}/api/filing-jobs/${job.id}/reconcile`,{headers:{Origin:url},data:{resolution:'found'}});
        assert.equal(incompleteConfirmation.status(),422);
        assert.equal(db.getFilingJob(job.id)!.status,'reconciliation_required');
        for(const ids of [[job.payload!.documents[0].id],job.payload!.documents.map(()=>job.payload!.documents[0].id)]) {
            assert.throws(()=>db.resolveFilingJobReconciliation({filingJobId:job.id,resolution:'found',verifiedDocumentIds:ids}),/every expected PDF/);
            assert.equal(db.getFilingJob(job.id)!.status,'reconciliation_required');
        }
        await page.locator('[data-reconcile-filing-job="found"]').click();
        assert.equal(await page.locator('#draftConfirmAccept').isDisabled(),true);
        await page.setViewportSize({width:390,height:844});
        assert.equal(await page.locator('#draftConfirmDialog').evaluate(element=>element.scrollWidth<=element.clientWidth+1),true);
        await page.screenshot({path:path.join(screenshots,'draft-reconcile-mobile.png'),fullPage:true});
        await page.locator('#draftConfirmDialog [value="cancel"]').click();
        await page.setViewportSize({width:1440,height:1000});
        assert.equal(db.getFilingJob(job.id)!.status,'reconciliation_required');
        await page.locator('[data-reconcile-filing-job="found"]').click();
        await page.locator('#draftReconcileComplete').check();
        await page.locator('#draftConfirmAccept').click();
        await page.waitForFunction(() => document.getElementById('draftFilingJobPanel')?.textContent?.includes('Prepared'));
        assert.equal(db.getDraftDetail(draftId)!.caseDraft!.status,'filing_prepared');
        assert.equal(db.listFilingJobs(draftId).length,1);
        assert.equal(db.getFilingJob(job.id)!.progress!.evidence,'confirmed');
        assert.equal(db.getFilingJob(job.id)!.progress!.uploaded,6);
        const debugFolder=path.join(process.env.MIFILE_FILING_DEBUG_DIR!,job.id);
        fs.mkdirSync(debugFolder,{recursive:true});
        const diagnostic=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l9sAAAAASUVORK5CYII=','base64');
        const diagnosticPath=path.join(debugFolder,'prepared.png');
        fs.writeFileSync(diagnosticPath,diagnostic);
        const diagnosticJob=db.getFilingJob(job.id)!;
        db.completeFilingJob({filingJobId:job.id,status:'prepared',checkpoint:'manually_reconciled',result:diagnosticJob.result,debugArtifactPath:diagnosticPath});
        const diagnosticResponse=await context.request.get(`${url}/api/filing-jobs/${job.id}/screenshot`);
        assert.equal(diagnosticResponse.status(),200);
        assert.equal(diagnosticResponse.headers()['content-type'],'image/png');
        assert.equal(diagnosticResponse.headers()['cache-control'],'no-store');
        assert.deepEqual(await diagnosticResponse.body(),diagnostic);
        const unauthenticated=await browser.newContext();
        try {assert.equal((await unauthenticated.request.get(`${url}/api/filing-jobs/${job.id}/screenshot`)).status(),401);}
        finally {await unauthenticated.close();}
        const outsideDiagnostic=path.join(directory,'outside.png');
        fs.writeFileSync(outsideDiagnostic,diagnostic);
        db.completeFilingJob({filingJobId:job.id,status:'prepared',checkpoint:'manually_reconciled',result:diagnosticJob.result,debugArtifactPath:outsideDiagnostic});
        assert.equal((await context.request.get(`${url}/api/filing-jobs/${job.id}/screenshot`)).status(),404);
        db.completeFilingJob({filingJobId:job.id,status:'prepared',checkpoint:'manually_reconciled',result:diagnosticJob.result,debugArtifactPath:diagnosticPath});
        await page.locator('#draftActivityTab').click();
        await page.locator('[data-release-checks] summary').click();
        assert.match(await page.locator('[data-release-checks]').innerText(),/No automatic readback recorded/);
        assert.match(await page.locator('[data-release-checks]').innerText(),/Payment and final court submission: Disabled/);
        await page.evaluate(() => (window as any).refreshDraftFilingState());
        assert.equal(await page.locator('[data-release-checks]').evaluate(element=>(element as HTMLDetailsElement).open),true);
        await page.screenshot({path:path.join(screenshots,'draft-release-checks-desktop.png'),fullPage:true});
        await page.setViewportSize({width:390,height:844});
        assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),true);
        await page.screenshot({path:path.join(screenshots,'draft-release-checks-mobile.png'),fullPage:true});
        await page.setViewportSize({width:1440,height:1000});
        await page.locator('#draftReviewTab').click();
        await page.screenshot({path:path.join(screenshots,'draft-prepared-desktop.png'),fullPage:true});
        const lockedDocument=db.getDraftDetail(draftId)!.documents.find(doc=>doc.isPrimary)!;
        assert.equal((await context.request.put(`${url}/api/documents/${lockedDocument.id}/content`,{headers:{Origin:url},data:testComplaintFormFixture()})).status(),409);
        assert.equal((await context.request.delete(`${url}/api/drafts/${draftId}/documents/${lockedDocument.id}`,{headers:{Origin:url}})).status(),409);
        await page.locator('#settingsTab').click();
        const localForm = db.listLibraryForms().find(form => form.role === 'local')!;
        page.once('dialog', dialog => dialog.accept());
        const disabled = page.waitForResponse(response => response.url().endsWith('/api/form-library/' + localForm.id) && response.request().method() === 'DELETE');
        await page.locator('[data-disable-form="' + localForm.id + '"]').click();
        await disabled;
        assert.equal(db.listLibraryForms().find(form => form.id === localForm.id)?.active, 0);
        await page.locator('#draftsTab').click();
        await page.locator('#closeDraftBtn').click();
        const created = page.waitForResponse(response => response.url().endsWith('/api/drafts') && response.request().method() === 'POST');
        await page.locator('#newDraftBtn').click();
        const manual = await (await created).json();
        assert.equal(JSON.parse(manual.caseDraft.normalizedDataJson).intake.manual, true);
        assert.equal(manual.caseDraft.manualPackage, true);
        assert.equal(manual.caseDraft.filingData.attorney.barNumber, 'P72877');
        assert.ok(!manual.caseDraft.validationIssues.some((issue: { message: string }) =>
            /standard nonpayment package|No Complaint document/.test(issue.message)));
        assert.equal(manual.caseDraft.status, 'needs_review');
        assert.equal(db.queueValidatedIntakes(), 0);
        await page.locator('#draftWorkspaceView').waitFor({state:'visible'});
        assert.equal((await page.locator('#draftApproveBtn').textContent())?.trim(), 'Confirm package');
        assert.equal(await page.locator('#draftPrepareBtn').innerText(), 'Review corrections');
        const failedDocument = db.addDocument({emailId:manual.email.id,caseDraftId:manual.caseDraft.id,
            currentFilename:'Unavailable Other.pdf',documentType:'Other',status:'failed',
            sourceUrl:'email-attachment://qa/Unavailable.pdf',uploadSource:'test',errorMessage:'Simulated PDF download timeout'});
        await page.evaluate(() => (window as any).refreshDraftFilingState());
        await page.locator('#draftDocumentSelect').selectOption(failedDocument);
        assert.match(await page.locator('#draftDocumentState').innerText(),/Simulated PDF download timeout/);
        assert.equal(await page.locator('#draftSourceLink').getAttribute('href'),null);
        await page.locator('#draftDocumentState [data-retry-document]').click();
        await page.waitForFunction(() => document.getElementById('draftDocumentState')?.textContent?.includes('Manual retry queued'));
        assert.equal(db.getDraftDetail(manual.caseDraft.id)!.documents[0].status,'retry_queued');
        assert.equal(db.getDraftDetail(manual.caseDraft.id)!.documents.length,1);
        await page.screenshot({path:path.join(screenshots,'draft-document-retry.png'),fullPage:true});
        await page.setViewportSize({width:390,height:844});
        await page.locator('[data-draft-mobile-mode="document"]').click();
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1),true);
        await page.screenshot({path:path.join(screenshots,'draft-document-retry-mobile.png'),fullPage:true});
        await page.setViewportSize({width:1440,height:1000});
        page.once('dialog',dialog=>dialog.accept());
        await clickDocumentTool('draftReplaceDocumentBtn');
        const repair=page.waitForResponse(response=>response.url().endsWith('/content') && response.request().method()==='PUT');
        await page.locator('#draftDocumentFileInput').setInputFiles({name:'Corrected Other.pdf',mimeType:'application/pdf',buffer:testPdfFixture('DEMAND FOR POSSESSION NONPAYMENT OF RENT')});
        assert.equal((await repair).status(),200);
        await page.waitForFunction(() => document.getElementById('closeDraftBtn')?.hasAttribute('disabled') === false);
        const repaired=db.getDraftDetail(manual.caseDraft.id)!.documents[0];
        assert.equal(repaired.id,failedDocument);assert.equal(repaired.status,'replaced');assert.ok(repaired.oneDriveUrl);
        assert.equal(repaired.sourceUrl,null);assert.equal(repaired.nextRetryAt,null);
        for(const name of ['Morgan Tenant','Taylor Resident']){
            if(name==='Taylor Resident'){
                await page.locator('#draftDataTab').click();
                const extras=page.locator('[data-disclosure="plaintiff-0"]');
                if(!await extras.evaluate(element=>(element as HTMLDetailsElement).open)) await extras.locator('summary').click();
                await extras.locator('[data-party-field="phone"]').fill('248-555-0191');
                await page.locator('#draftSaveBtn').click();
                await page.waitForFunction(()=>document.getElementById('draftSaveBtn')?.hasAttribute('disabled')===true);
            }
            const replaced=page.waitForResponse(response=>response.url().endsWith('/content') && response.request().method()==='PUT');
            await clickDocumentTool('draftReplaceDocumentBtn');
            page.once('dialog',dialog=>dialog.accept());
            await page.locator('#draftDocumentFileInput').setInputFiles({name:'Complaint.pdf',mimeType:'application/pdf',
                buffer:testComplaintFormFixture({7:name+', and all other occupants\r200 Rental Avenue\rLincoln Park, MI 48146'})});
            assert.equal((await replaced).status(),200);
            await page.waitForFunction(()=>document.getElementById('closeDraftBtn')?.hasAttribute('disabled')===false);
            assert.equal(db.getDraftDetail(manual.caseDraft.id)!.caseDraft!.complaintExtraction?.extractorVersion,CURRENT_COMPLAINT_EXTRACTOR_VERSION);
            assert.equal(db.getDraftDetail(manual.caseDraft.id)!.caseDraft!.filingData.defendants[0].displayName,name);
            if(name==='Taylor Resident') assert.equal(db.getDraftDetail(manual.caseDraft.id)!.caseDraft!.filingData.plaintiff!.phone,'248-555-0191');
        }
        await page.screenshot({path:path.join(screenshots,'draft-complaint-replacement.png'),fullPage:true});
        const oneDriveCount=storedFiles.size;
        page.once('dialog',dialog=>dialog.accept());
        const removeOriginal=page.waitForResponse(response=>response.request().method()==='DELETE' && response.url().includes('/documents/'+failedDocument));
        await clickDocumentTool('draftRemoveFormBtn');
        assert.equal((await removeOriginal).status(),200);
        await page.waitForFunction(id=>!document.querySelector('#draftDocumentSelect option[value="'+id+'"]'),failedDocument);
        assert.equal(storedFiles.size,oneDriveCount);
        const remaining=db.getDraftDetail(manual.caseDraft.id)!.documents.length;
        rejectUpload=true;
        await page.locator('#draftAddDocumentBtn').click();
        const failedUpload=page.waitForResponse(response=>response.url().endsWith('/documents') && response.request().method()==='POST');
        await page.locator('#draftDocumentFileInput').setInputFiles({name:'New Other.pdf',mimeType:'application/pdf',buffer:testPdfFixture('DEMAND FOR POSSESSION NONPAYMENT OF RENT')});
        assert.equal((await failedUpload).status(),502);
        await page.waitForFunction(() => document.getElementById('closeDraftBtn')?.hasAttribute('disabled') === false);
        assert.equal(db.getDraftDetail(manual.caseDraft.id)!.documents.length,remaining+1);
        assert.equal(db.getDraftDetail(manual.caseDraft.id)!.documents.find(doc=>doc.originalFilename==='New Other.pdf')!.status,'failed');
        rejectUpload=false;
        await page.screenshot({path:path.join(screenshots,'draft-upload-recovery.png'),fullPage:true});
        await page.locator('#closeDraftBtn').click();
        await page.locator(`[data-open-draft="${notificationDraftId}"]`).click();
        assert.equal(await page.locator('#draftManualCopyBtn').isHidden(), true);
        const blockedCopy = await context.request.post(
            `${url}/api/drafts/${notificationDraftId}/manual-copy`, { headers: { Origin: url } });
        assert.equal(blockedCopy.status(), 409);
        assert.equal(db.getDraftDetail(notificationDraftId)?.caseDraft?.filingEligible, false);
        assert.deepEqual(errors, []);
        await page.locator('#signOutBtn').click();
        await page.waitForURL(url + '/login');
        assert.equal((await context.request.get(`${url}/api/settings`)).status(), 401);
        await page.goto(url);
        await page.locator('#loginForm').waitFor();
        console.log('Admin smoke passed: login/logout, settings, form library upload/preview, content recognition, automatic court form, idempotency, PDF preview, AcroForm Complaint fields, desktop/mobile layouts.');
        console.log(`Screenshots: ${screenshots}`);
    } finally {
        await browser.close();
        await new Promise<void>(resolve => server.close(() => resolve()));
        db.close();
        process.chdir(originalCwd);
        fs.rmSync(directory, { recursive: true, force: true });
    }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
