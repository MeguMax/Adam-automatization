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
        MIFILE_AUTO_STATUS_REFRESH_ENABLED:'false',
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
    const microsoft = require('./microsoftAccess');
    let microsoftChecks = 0;
    let releaseMicrosoftCheck!: () => void;
    let microsoftStarted!: () => void;
    const microsoftGate = new Promise<void>(resolve => { releaseMicrosoftCheck = resolve; });
    const microsoftRequested = new Promise<void>(resolve => { microsoftStarted = resolve; });
    microsoft.checkMicrosoftAccess = async () => {
        microsoftChecks++;
        microsoftStarted();
        await microsoftGate;
        return {
            checkedAt: new Date().toISOString(), readOnly: true,
            authentication: { status: 'ok' }, inbox: { status: 'failed', reason: 'access_denied', http: 403 },
            oneDrive: { status: 'ok', host: 'fixture-my.sharepoint.com' },
            fileWritePermission: 'granted_not_tested', mailSendPermission: 'granted_not_tested',
        };
    };
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
    const {workerHealth}=require('./workerHealth') as typeof import('./workerHealth');
    workerHealth.start('inbox',10_000); workerHealth.finish('inbox'); workerHealth.disable('mifile');
    const server = createAdminServer(0, { handleSignals: false, closeDatabaseOnShutdown: false, filingWorkerAvailable:()=>true });
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
        assert.equal((await context.request.get(url+'/api/worker-health')).status(),401);
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
        await page.locator('#workerStatusBtn').click();
        await page.waitForFunction(()=>document.getElementById('workerStatusList')?.textContent?.includes('Idle'));
        assert.ok((await page.locator('#workerStatusList').textContent())?.includes('Disabled'));
        await page.screenshot({path:path.join(screenshots,'worker-health-desktop.png')});
        workerHealth.finish('inbox',false);
        await page.locator('[aria-label="Close worker status"]').click();
        await page.locator('#workerStatusBtn').click();
        await page.waitForFunction(()=>document.getElementById('workerStatusList')?.textContent?.includes('Last cycle failed'));
        await page.setViewportSize({width:390,height:844});
        assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
        await page.screenshot({path:path.join(screenshots,'worker-health-mobile.png')});
        await page.locator('[aria-label="Close worker status"]').click();
        await page.setViewportSize({width:1440,height:1000});
        await page.locator('#settingsTab').click();
        await page.waitForFunction(() => document.getElementById('intakeMailbox')?.textContent === 'intake@example.com');
        assert.equal(microsoftChecks, 0, 'Opening Settings must not request Microsoft resources');
        assert.equal(await page.locator('#microsoftAuthStatus').textContent(), 'Not checked');
        assert.equal(await page.locator('#microsoftExcelSaving').textContent(), 'Download to computer');
        const checkUrl = `${url}/api/settings/microsoft/check`;
        const checkHeaders = { 'X-Admin-Action': 'microsoft-access', Origin: url };
        assert.equal((await context.request.post(checkUrl, { data: {} })).status(), 403);
        assert.equal((await context.request.post(checkUrl, { headers: { ...checkHeaders, Origin: 'https://foreign.example' }, data: {} })).status(), 403);
        assert.equal((await context.request.post(checkUrl, { headers: checkHeaders, data: { folder: 'https://foreign.example' } })).status(), 400);
        const unsigned = await browser.newContext();
        try { assert.equal((await unsigned.request.post(checkUrl, { headers: checkHeaders, data: {} })).status(), 401); }
        finally { await unsigned.close(); }
        assert.equal(microsoftChecks, 0);
        for (const status of [502, 503, 504, 200]) {
            await context.route(checkUrl, route => route.fulfill({ status, contentType: 'text/html',
                body: '<!DOCTYPE html><html><body>private gateway diagnostic</body></html>' }));
            await page.locator('#microsoftCheck').click();
            const expected = status === 200 ? 'Unexpected server response. Refresh this page and try again.'
                : 'Service temporarily unavailable. Please try again shortly.';
            await page.waitForFunction(value => document.getElementById('microsoftCheckMessage')?.textContent === value, expected);
            assert.equal(await page.locator('#microsoftCheck').isEnabled(), true);
            assert.equal(microsoftChecks, 0, 'HTML gateway failures must not start or automatically retry a connection check');
            await context.unroute(checkUrl);
        }
        await page.locator('#microsoftCheck').click();
        await microsoftRequested;
        assert.equal(await page.locator('#microsoftCheck').isDisabled(), true);
        const concurrentCheck = context.request.post(checkUrl, { headers: checkHeaders, data: {} });
        releaseMicrosoftCheck();
        const checked = await concurrentCheck;
        assert.equal(checked.status(), 200);
        assert.equal((await checked.json()).report.readOnly, true);
        await page.waitForFunction(() => document.getElementById('microsoftDriveStatus')?.textContent === 'Connected');
        assert.equal(await page.locator('#microsoftAuthStatus').textContent(), 'Connected');
        assert.equal(await page.locator('#microsoftInboxStatus').textContent(), 'Access denied');
        assert.equal(await page.locator('#microsoftWriteStatus').textContent(), 'Granted (not tested)');
        assert.equal(await page.locator('#microsoftSendStatus').textContent(), 'Granted (not tested)');
        assert.equal(await page.locator('#microsoftCheck').isEnabled(), true);
        await page.locator('#microsoftCheck').click();
        await page.waitForFunction(() => document.getElementById('microsoftCheckMessage')?.textContent?.startsWith('Read-only check:'));
        assert.equal(microsoftChecks, 1, 'Concurrent/repeated checks must share the recent read-only result');
        await page.locator('#microsoftCheck').locator('..').locator('..').screenshot({ path: path.join(screenshots, 'microsoft-connection-desktop.png') });
        await page.setViewportSize({ width: 390, height: 844 });
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true);
        await page.locator('#microsoftCheck').locator('..').locator('..').screenshot({ path: path.join(screenshots, 'microsoft-connection-mobile.png') });
        await page.setViewportSize({ width: 1440, height: 1000 });
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
        const canvas = page.locator('#draftPdfViewer canvas');
        await canvas.waitFor({ state: 'visible' });
        assert.ok(await canvas.evaluate(element => {
            const canvas = element as HTMLCanvasElement;
            const data = canvas.getContext('2d')!.getImageData(0, 0, canvas.width, canvas.height).data;
            let ink = 0;
            for (let index = 0; index < data.length; index += 4) if (data[index] < 180 && data[index + 3] > 0) ink++;
            return ink > 20;
        }), 'PDF canvas must contain rendered document content');
        const zoomControl = page.locator('#draftPdfViewer').getByRole('combobox',{name:'PDF zoom'});
        await zoomControl.selectOption('1.5');
        await page.evaluate(() => (window as any).renderDraftWorkspace());
        assert.equal(await zoomControl.inputValue(), '1.5', 'Live updates must preserve PDF navigation');
        await zoomControl.selectOption('fit');
        await page.screenshot({ path: path.join(screenshots, 'draft-desktop.png'), fullPage: true });
        await page.setViewportSize({ width: 390, height: 844 });
        await page.waitForFunction(() => {
            const canvas = document.querySelector('#draftPdfViewer canvas');
            const pages = document.querySelector('#draftPdfViewer .pdf-preview-pages');
            return canvas && pages && canvas.getBoundingClientRect().width <= pages.clientWidth;
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
        await page.locator('#draftDocumentFileInput').setInputFiles({ name:'Complaint.pdf',mimeType:'application/pdf',buffer:testComplaintFormFixture({
            6:'Adam J Devlin P72877\r30850 Telegraph Rd Ste 250\rBingham Farms, MI 48025\r248 703 6201',
        }) });
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
        await page.locator('#draftPdfViewer canvas').waitFor({state:'visible'});
        await page.locator('#draftPdfViewer .pdf-preview-message').waitFor({state:'hidden'});
        await page.screenshot({path:path.join(screenshots,'complaint-fields-desktop.png'),fullPage:true});
        await page.setViewportSize({width:390,height:844});
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1),true);
        await page.locator('#draftDocumentTools summary').click();
        assert.equal(await page.locator('.draft-source-actions button').evaluateAll(buttons => buttons.every(button => {
            const rect=button.getBoundingClientRect();
            return rect.left>=0 && rect.right<=window.innerWidth && button.clientWidth>=button.scrollWidth;
        })),true,'Every mobile document action must fit its panel');
        await page.locator('#draftDocumentTools summary').click();
        await page.waitForFunction(() => {
            const canvas=document.querySelector('#draftPdfViewer canvas');
            const pages=document.querySelector('#draftPdfViewer .pdf-preview-pages');
            return canvas && pages && canvas.getBoundingClientRect().width<=pages.clientWidth;
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
        const saveSupporting = async () => {
            const saved=page.waitForResponse(response=>response.url().endsWith('/api/drafts/'+draftId) && response.request().method()==='PATCH');
            await page.locator('#draftSaveBtn').click();
            assert.equal((await saved).status(),200);
            await page.waitForFunction(()=>document.getElementById('draftSaveBtn')?.hasAttribute('disabled')===true);
        };
        const contents=ancillaryRow.locator('[data-document-field="supportingKind"]');
        const requiredSupport=page.locator('[data-draft-field="supportingRequirement"]');
        assert.equal(await contents.inputValue(),'demand');
        const missingPins=await context.request.patch(`${url}/api/drafts/${draftId}`,{headers:{Origin:url},data:{fields:{},documents:[{
            id:ancillary.id,filingType:ancillary.filingType,filingName:ancillary.filingName,filingRelation:'separate',
            supportingKind:'demand',supportingKindReviewed:true}]}});
        assert.equal(missingPins.status(),409);
        const stalePins=await context.request.patch(`${url}/api/drafts/${draftId}`,{headers:{Origin:url},data:{fields:{},documents:[{
            id:ancillary.id,filingType:ancillary.filingType,filingName:ancillary.filingName,filingRelation:'separate',
            supportingKind:'demand',supportingKindReviewed:true,expectedSourceVersion:'stale-source',
            expectedContentHash:ancillary.supportingEvidence!.contentHash}]}});
        assert.equal(stalePins.status(),409);
        const missingContext=await context.request.patch(`${url}/api/drafts/${draftId}`,{headers:{Origin:url},
            data:{fields:{supportingRequirement:'none',supportingRequirementReason:'Stale review without a package context.'}}});
        assert.equal(missingContext.status(),409);
        assert.deepEqual(db.getDraftDetail(draftId)!.caseDraft!.validationIssues,[]);
        await contents.selectOption('deed');await saveSupporting();
        assert.ok(db.getDraftDetail(draftId)!.caseDraft!.validationIssues.some(issue=>issue.field==='package.supporting'));
        await ancillaryRow.locator('[data-document-field="filingType"]').fill('Other');await saveSupporting();
        assert.equal(db.getDraftDetail(draftId)!.documents.find(doc=>doc.id===ancillary.id)!.supportingEvidence!.kind,'deed');
        assert.ok(db.getDraftDetail(draftId)!.caseDraft!.validationIssues.some(issue=>issue.field==='package.supporting'));
        await requiredSupport.selectOption('none');
        await page.locator('[data-draft-field="supportingRequirementReason"]').fill('Attorney reviewed the exception for this synthetic QA case.');
        await saveSupporting();
        assert.deepEqual(db.getDraftDetail(draftId)!.caseDraft!.validationIssues,[]);
        assert.equal(db.getDraftDetail(draftId)!.caseDraft!.packageCompleteness.source,'manual');
        await contents.selectOption('other');await saveSupporting();
        assert.equal(db.getDraftDetail(draftId)!.caseDraft!.packageCompleteness.reviewStale,true);
        await page.locator('[data-review-supporting-requirement]').click();await saveSupporting();
        assert.equal(db.getDraftDetail(draftId)!.caseDraft!.packageCompleteness.reviewStale,false);
        await requiredSupport.selectOption('auto');await saveSupporting();
        assert.ok(db.getDraftDetail(draftId)!.caseDraft!.validationIssues.some(issue=>issue.field==='package.supporting'));
        await page.getByRole('heading',{name:'Supporting documents',exact:true}).click();
        await page.screenshot({path:path.join(screenshots,'draft-supporting-completeness-desktop.png'),fullPage:true});
        await page.setViewportSize({width:390,height:844});
        assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),true);
        await page.screenshot({path:path.join(screenshots,'draft-supporting-completeness-mobile.png'),fullPage:true});
        await page.setViewportSize({width:1440,height:1000});
        await contents.selectOption('demand');await saveSupporting();
        assert.deepEqual(db.getDraftDetail(draftId)!.caseDraft!.validationIssues,[]);
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
        await page.locator('#draftPdfViewer canvas').waitFor({state:'visible'});
        await page.locator('#draftPdfViewer .pdf-preview-message').waitFor({state:'hidden'});
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
        const {getCheckoutAccount}=require('./mifileCheckoutRunner') as typeof import('./mifileCheckoutRunner');
        const {preparationDigest}=require('./mifilePreparationEvidence') as typeof import('./mifilePreparationEvidence');
        const {buildCheckoutQuote,digest}=require('./mifileCheckout') as typeof import('./mifileCheckout');
        const checkoutAccount=getCheckoutAccount();
        const bundleId='fd2c1ad4-633d-429a-0166-08df32c555de';
        const sources=job.payload!.documents.map(document=>({documentId:document.id,sha256:'ab'.repeat(32),bytes:200}));
        const packageDigest=preparationDigest(job.payload!,sources);
        db.completeFilingJob({filingJobId:job.id,status:'prepared',checkpoint:'saved_unsubmitted',externalBundleId:bundleId,temporaryCaseNumber:'TEMP-QA',result:{
            ...diagnosticJob.result,url:'https://mifile.courts.michigan.gov/filing/create/'+bundleId,
            documentManifest:job.payload!.documents.map(document=>({documentId:document.id,filingName:document.filingName,
                filingType:document.filingRelation==='connected_to_complaint'?'CONNECTED FILING':document.filingType,
                filingRelation:document.filingRelation,parentDocumentId:document.filingRelation==='connected_to_complaint'?job.payload!.documents.find(doc=>doc.isPrimary)!.id:null})),
            savedBundleEvidence:{version:1,verifiedAt:new Date().toISOString(),sourcePdfCount:sources.length,generatedPdfCount:1,
                connectedPdfCount:0,courtName:job.payload!.courtName,externalBundleId:bundleId,temporaryCaseNumber:'TEMP-QA',
                filer:'Devlin, Adam (P72877)',accountEmail:checkoutAccount.username,sources,packageDigest},
        }});
        const quoteJob=db.getFilingJob(job.id)!;
        const paymentMethods=[{fingerprint:digest('fixture-token'),label:'Card ending 1234'},
            {fingerprint:digest('fixture-token-2'),label:'Bank account ending 5678'}];
        const quoted=buildCheckoutQuote(quoteJob,checkoutAccount,[['Filing Fee','$90.00'],['eFiling System Fee','$20.00'],
            ['Processing Service Fee *','$3.69'],['Additional Payment','$13.00'],['Total','$126.69']],
            {state:'selected',fingerprint:digest('fixture-token'),available:paymentMethods},packageDigest,10300);
        const inspection=db.checkout().queue(job.id,'quote',checkoutAccount);db.checkout().claim();
        db.checkout().complete(inspection.id,{kind:'quote',quote:quoted},checkoutAccount);
        await page.evaluate(()=>(window as any).refreshDraftFilingState());
        await page.locator('[data-checkout-review] summary').click();
        assert.match(await page.locator('[data-checkout-review]').innerText(),/Checkout total:\s+\$126.69 USD/);
        assert.match(await page.locator('[data-release-checks]').textContent() || '',
            /Checkout total and processing fee: Read from MiFILE/);
        const denied=await context.request.post(`${url}/api/filing-jobs/${job.id}/checkout/pay`,{headers:{Origin:url},data:{}});
        assert.equal(denied.status(),403);
        const wrongAmount=await context.request.post(`${url}/api/filing-jobs/${job.id}/checkout/confirm`,{headers:{Origin:url},
            data:{quoteId:quoted.id,quoteDigest:quoted.quoteDigest,totalCents:12668}});
        assert.equal(wrongAmount.status(),409);
        await page.locator('[data-checkout-action="confirm"]').click();
        assert.match(await page.locator('#draftConfirmDialog').innerText(),/does not authorize payment/);
        await page.locator('#draftConfirmAccept').click();
        await page.locator('[data-checkout-action="confirm"]').waitFor({state:'visible'});
        await page.waitForFunction(()=>document.querySelector('[data-checkout-review]')?.textContent?.includes('Amount reviewed:'));
        assert.ok(db.checkout().state(job.id,checkoutAccount).confirmedAt);
        assert.equal(db.checkout().state(job.id,checkoutAccount).paymentExecutionEnabled,false);
        await page.evaluate(()=>(window as any).refreshDraftFilingState());
        assert.equal(await page.locator('[data-checkout-review]').evaluate(element=>(element as HTMLDetailsElement).open),true);
        await page.screenshot({path:path.join(screenshots,'draft-checkout-review-desktop.png'),fullPage:true});
        await page.setViewportSize({width:390,height:844});
        assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),true);
        await page.screenshot({path:path.join(screenshots,'draft-checkout-review-mobile.png'),fullPage:true});
        await page.setViewportSize({width:1440,height:1000});
        await page.locator('#checkoutPaymentMethod').selectOption(paymentMethods[1].fingerprint);
        await page.evaluate(()=>(window as any).refreshDraftFilingState());
        assert.equal(await page.locator('#checkoutPaymentMethod').inputValue(),paymentMethods[1].fingerprint);
        const invalidMethod=await context.request.post(`${url}/api/filing-jobs/${job.id}/checkout/payment-method`,{headers:{Origin:url},
            data:{quoteId:quoted.id,quoteDigest:quoted.quoteDigest,paymentMethodFingerprint:digest('not-available')}});
        assert.equal(invalidMethod.status(),409);
        await page.locator('[data-checkout-action="payment-method"]').click();
        await page.waitForFunction(()=>document.querySelector('[data-checkout-review]')?.textContent?.includes('Checking MiFILE:'));
        assert.equal(db.checkout().state(job.id,checkoutAccount).confirmedAt,null);
        assert.equal(db.checkout().paymentMethodChoice(job.id,checkoutAccount),paymentMethods[1].fingerprint);
        const nextInspection=db.checkout().claim()!;
        const switchedQuote=buildCheckoutQuote(quoteJob,checkoutAccount,[['Filing Fee','$90.00'],['eFiling System Fee','$20.00'],
            ['Processing Service Fee *','$3.69'],['Additional Payment','$13.00'],['Total','$126.69']],
            {state:'selected',fingerprint:paymentMethods[1].fingerprint,available:paymentMethods},packageDigest,10300);
        db.checkout().complete(nextInspection.id,{kind:'quote',quote:switchedQuote},checkoutAccount);
        await page.evaluate(()=>(window as any).refreshDraftFilingState());
        assert.match(await page.locator('[data-checkout-review]').innerText(),/Payment account: Bank account ending 5678/);
        assert.equal(await page.locator('[data-checkout-action="confirm"]').isEnabled(),true);
        assert.equal(db.checkout().state(job.id,checkoutAccount).preflight.executionEnabled,false);
        await page.locator('[data-checkout-action="clear-method"]').click();
        await page.waitForFunction(()=>document.querySelector('[data-checkout-review]')?.textContent?.includes('Checking MiFILE:'));
        const clearInspection=db.checkout().claim()!;
        assert.equal(db.checkout().paymentMethodChoice(job.id,checkoutAccount),null);
        db.checkout().fail(clearInspection.id,'QA refresh interrupted; nothing charged');
        await page.evaluate(()=>(window as any).refreshDraftFilingState());
        assert.equal(await page.locator('[data-checkout-action="confirm"]').isEnabled(),false);
        const emptyInspection=db.checkout().queue(job.id,'quote',checkoutAccount);db.checkout().claim();
        const emptyQuote=buildCheckoutQuote(quoteJob,checkoutAccount,[['Filing Fee','$90.00'],['eFiling System Fee','$20.00'],
            ['Processing Service Fee *','$3.69'],['Additional Payment','$13.00'],['Total','$126.69']],
            {state:'unverified',fingerprint:null,available:[]},packageDigest,10300);
        db.checkout().complete(emptyInspection.id,{kind:'quote',quote:emptyQuote},checkoutAccount);
        await page.evaluate(()=>(window as any).refreshDraftFilingState());
        assert.match(await page.locator('[data-checkout-review]').innerText(),/Linked account not independently verified/);
        assert.match(await page.locator('[data-checkout-review]').innerText(),/Add Payment Account button alone does not mean a linked card is missing/);
        assert.doesNotMatch(await page.locator('[data-checkout-review]').innerText(),/Add a payment method to this MiFILE login/);
        assert.equal(await page.locator('#checkoutPaymentMethod').count(),0);
        assert.equal(await page.locator('[data-checkout-action="confirm"]').isEnabled(),false);
        await page.screenshot({path:path.join(screenshots,'draft-checkout-unverified-payment.png'),fullPage:true});
        await page.locator('#draftReviewTab').click();
        assert.equal(await page.locator('#draftValidationSummary').innerText(),'');
        assert.match(await page.locator('#draftPreparationStatus').innerText(),/MiFILE status not checked/);
        await page.screenshot({path:path.join(screenshots,'draft-prepared-desktop.png'),fullPage:true});
        const lockedDocument=db.getDraftDetail(draftId)!.documents.find(doc=>doc.isPrimary)!;
        assert.equal((await context.request.put(`${url}/api/documents/${lockedDocument.id}/content`,{headers:{Origin:url},data:testComplaintFormFixture()})).status(),409);
        assert.equal((await context.request.delete(`${url}/api/drafts/${draftId}/documents/${lockedDocument.id}`,{headers:{Origin:url}})).status(),409);
        const fresh = await context.newPage();
        try {
            await fresh.setViewportSize({width:1440,height:1000});
            await fresh.goto(url);
            await fresh.locator('#draftsTab').click();
            await fresh.locator('[data-open-draft="'+draftId+'"]').click();
            const pdf = fresh.locator('#draftPdfViewer');
            await pdf.locator('canvas').waitFor({state:'visible'});
            await pdf.locator('.pdf-preview-message').waitFor({state:'hidden'});
            const nonblank = () => pdf.locator('canvas').evaluate(canvas => {
                const c = canvas as HTMLCanvasElement;
                const pixels = c.getContext('2d')!.getImageData(0,0,c.width,c.height).data;
                for(let i=0;i<pixels.length;i+=4) if(pixels[i+3]>0 && pixels[i]<200 && pixels[i+1]<200 && pixels[i+2]<200) return true;
                return false;
            });
            assert.equal(await nonblank(),true,'Initial prepared-Draft preview renders without switching documents');
            assert.equal(await fresh.locator('#draftPdfViewer iframe').count(),0);
            await fresh.locator('#draftPdfViewer canvas').evaluate(canvas=>canvas.setAttribute('data-qa-preserved','true'));
            await fresh.evaluate(()=>(window as any).refreshDraftFilingState());
            assert.equal(await fresh.locator('#draftPdfViewer canvas').getAttribute('data-qa-preserved'),'true');
            await fresh.route('**/api/documents/'+lockedDocument.id+'/content?*',route=>route.fulfill({status:502,contentType:'text/html',body:'QA gateway failure'}));
            await fresh.reload();
            await fresh.locator('#draftsTab').click();
            await fresh.locator('[data-open-draft="'+draftId+'"]').click();
            await pdf.getByRole('button',{name:'Retry preview',exact:true}).waitFor({state:'visible'});
            assert.ok((await pdf.locator('.pdf-preview-message').innerText()).includes('temporarily unavailable'));
            assert.ok((await fresh.locator('#draftPdfViewer a').getAttribute('href'))?.includes('/api/documents/'+lockedDocument.id+'/content'));
            assert.equal(await fresh.locator('#draftPdfViewer a').getAttribute('target'),'_blank');
            await fresh.screenshot({path:path.join(screenshots,'draft-inline-preview-error.png'),fullPage:true});
            await fresh.setViewportSize({width:390,height:844});
            assert.equal(await fresh.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),true);
            await fresh.screenshot({path:path.join(screenshots,'draft-inline-preview-error-mobile.png'),fullPage:true});
            await fresh.setViewportSize({width:1440,height:1000});
            await fresh.unroute('**/api/documents/'+lockedDocument.id+'/content?*');
            await pdf.getByRole('button',{name:'Retry preview',exact:true}).click();
            await pdf.locator('canvas').waitFor({state:'visible'});
            await pdf.locator('.pdf-preview-message').waitFor({state:'hidden'});
            assert.equal(await nonblank(),true,'Manual retry restores a nonblank inline PDF after a temporary server error');
            await fresh.screenshot({path:path.join(screenshots,'draft-initial-preview-desktop.png'),fullPage:true});
            await fresh.setViewportSize({width:390,height:844});
            await fresh.waitForFunction(()=>{
                const pages=document.querySelector<HTMLElement>('#draftPdfViewer .pdf-preview-pages');
                const canvas=pages?.querySelector('canvas');
                return Boolean(pages&&canvas&&canvas.getBoundingClientRect().width<=pages.clientWidth-20);
            });
            assert.equal(await fresh.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),true);
            await fresh.screenshot({path:path.join(screenshots,'draft-initial-preview-mobile.png'),fullPage:true});
        } finally {await fresh.close();}
        process.env.MIFILE_AUTO_STATUS_REFRESH_ENABLED='true';
        const automaticResponse=await context.request.post(`${url}/api/filing-jobs/${job.id}/checkout/refresh-status`,{headers:{Origin:url},data:{}});
        assert.equal(automaticResponse.status(),200);
        const automaticCheck=db.checkout().claim()!;
        assert.equal(automaticCheck.triggerSource,'automatic');assert.equal(automaticCheck.kind,'receipts');
        db.checkout().complete(automaticCheck.id,{kind:'receipts',state:'unsubmitted',checkedAt:new Date().toISOString(),issue:null,
            observations:[{bundleId,accountEmail:checkoutAccount.username,kind:'bundle_status',externalReference:bundleId,
                documentId:null,status:'Unsubmitted',occurredAt:null,observedAt:new Date().toISOString(),totalCents:null,currency:null,
                receiptUrl:null,source:'mifile_history'}]},checkoutAccount);
        await context.request.post(`${url}/api/filing-jobs/${job.id}/checkout/refresh-status`,{headers:{Origin:url},data:{}});
        assert.equal(db.checkout().claim(),null);
        process.env.MIFILE_AUTO_STATUS_REFRESH_ENABLED='false';
        const paidCheck=db.checkout().queue(job.id,'receipts',checkoutAccount);db.checkout().claim();
        db.checkout().complete(paidCheck.id,{kind:'receipts',state:'found',checkedAt:new Date().toISOString(),issue:null,
            observations:[{bundleId,accountEmail:checkoutAccount.username,kind:'payment',externalReference:'QA-PAID-ONLY',
                documentId:null,status:'Paid',occurredAt:null,observedAt:new Date().toISOString(),totalCents:12669,currency:'USD',
                receiptUrl:'https://mifile.courts.michigan.gov/receipts/qa-only.pdf',source:'mifile_history'}]},checkoutAccount);
        await page.evaluate(()=>(window as any).refreshDraftFilingState());
        assert.match(await page.locator('#draftPreparationStatus').innerText(),/Payment receipt verified/);
        assert.match(await page.locator('#draftNextActionNote').innerText(),/not court acceptance/);
        assert.ok(!(await page.locator('#draftNextActionNote').innerText()).includes('Nothing has been sent'));
        assert.equal(db.getDraftDetail(draftId)!.caseDraft!.filingStatus,'prepared');
        await page.locator('#draftActivityTab').click();
        assert.equal(await page.locator('[data-checkout-action="inspect"]').isEnabled(),false);
        assert.equal(await page.locator('[data-checkout-review] a').getAttribute('href'),'https://mifile.courts.michigan.gov/receipts/qa-only.pdf');
        await page.locator('#draftReviewTab').click();
        await page.screenshot({path:path.join(screenshots,'draft-payment-result-desktop.png'),fullPage:true});
        await page.setViewportSize({width:390,height:844});
        assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),true);
        await page.screenshot({path:path.join(screenshots,'draft-payment-result-mobile.png'),fullPage:true});
        await page.setViewportSize({width:1440,height:1000});
        const rejectedCheck=db.checkout().queue(job.id,'receipts',checkoutAccount);db.checkout().claim();
        db.checkout().complete(rejectedCheck.id,{kind:'receipts',state:'found',checkedAt:new Date().toISOString(),issue:null,
            observations:[{bundleId,accountEmail:checkoutAccount.username,kind:'filing_status',externalReference:'QA-REJECTED-DOC',
                documentId:job.payload!.documents[0].id,status:'Rejected',occurredAt:null,observedAt:new Date().toISOString(),totalCents:null,currency:null,
                receiptUrl:null,source:'mifile_history',message:'Missing Demand <img src=x onerror=alert(1)>'}]},checkoutAccount);
        await page.evaluate(()=>(window as any).refreshDraftFilingState());
        assert.match(await page.locator('#draftNextActionNote').innerText(),/Missing Demand/);
        await page.locator('#draftActivityTab').click();
        assert.match(await page.locator('[data-checkout-review]').innerText(),/Missing Demand <img src=x onerror=alert\(1\)>/);
        assert.match(await page.locator('[data-checkout-review]').innerText(),new RegExp(job.payload!.documents[0].filingName.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')));
        assert.equal(await page.locator('[data-checkout-review] img').count(),0);
        assert.equal(await page.locator('[data-checkout-action="inspect"]').isEnabled(),false);
        await page.locator('[data-checkout-review]').scrollIntoViewIfNeeded();
        await page.screenshot({path:path.join(screenshots,'draft-rejection-comment-desktop.png'),fullPage:true});
        await page.setViewportSize({width:390,height:844});
        assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),true);
        await page.screenshot({path:path.join(screenshots,'draft-rejection-comment-mobile.png'),fullPage:true});
        await page.setViewportSize({width:1440,height:1000});
        await page.locator('#settingsTab').click();
        const localForm = db.listLibraryForms().find(form => form.role === 'local')!;
        page.once('dialog', dialog => dialog.accept());
        const disabled = page.waitForResponse(response => response.url().endsWith('/api/form-library/' + localForm.id) && response.request().method() === 'DELETE');
        await page.locator('[data-disable-form="' + localForm.id + '"]').click();
        await disabled;
        assert.equal(db.listLibraryForms().find(form => form.id === localForm.id)?.active, 0);
        await page.locator('#draftsTab').click();
        await page.locator('#closeDraftBtn').click();
        for (const invalid of [{packageMode:'unknown'}, [], null]) {
            const rejected = await context.request.post(`${url}/api/drafts`, {headers:{Origin:url},data:invalid});
            assert.equal(rejected.status(), 400);
        }
        const standardCreated = page.waitForResponse(response => response.url().endsWith('/api/drafts') && response.request().method() === 'POST');
        await page.locator('#newDraftBtn').click();
        const standard = await (await standardCreated).json();
        assert.equal(JSON.parse(standard.caseDraft.normalizedDataJson).intake.packageMode, 'standard_lt');
        assert.equal(standard.caseDraft.manualPackage, false);
        assert.ok(standard.caseDraft.validationIssues.some((issue: {field:string}) => issue.field === 'package.request'));
        assert.equal((await context.request.post(`${url}/api/drafts/${standard.caseDraft.id}/filing-jobs`,
            {headers:{Origin:url},data:{mode:'prepare'}})).status(), 409);
        await page.locator('#draftWorkspaceView').waitFor({state:'visible'});
        await page.screenshot({path:path.join(screenshots,'draft-standard-upload-desktop.png'),fullPage:true});
        await page.locator('#closeDraftBtn').click();
        const created = page.waitForResponse(response => response.url().endsWith('/api/drafts') && response.request().method() === 'POST');
        await page.locator('#newDraftOptions summary').click();
        await page.setViewportSize({width:390,height:844});
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true);
        const mobileParties = await page.locator('#draftList [data-open-draft] td:nth-child(3)').evaluateAll(cells =>
            cells.map(cell => cell.getBoundingClientRect().width));
        assert.ok(mobileParties.length && mobileParties.every(width => width > 300), 'party columns must remain readable');
        await page.screenshot({path:path.join(screenshots,'draft-create-options-mobile.png'),fullPage:true});
        await page.setViewportSize({width:1440,height:1000});
        await page.locator('#newCustomDraftBtn').click();
        const manual = await (await created).json();
        assert.equal(JSON.parse(manual.caseDraft.normalizedDataJson).intake.manual, true);
        assert.equal(JSON.parse(manual.caseDraft.normalizedDataJson).intake.packageMode, 'custom');
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
                buffer:testComplaintFormFixture({6:'Adam J Devlin P72877\r30850 Telegraph Rd Ste 250\rBingham Farms, MI 48025\r248 703 6201',
                    7:name+', and all other occupants\r200 Rental Avenue\rLincoln Park, MI 48146'})});
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
        await page.locator('#loginForm').waitFor();
        assert.equal(page.url(), url + '/login');
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
