import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { chromium } from 'playwright';
import { testPdfFixture } from './testPdfFixture';

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
        ADMIN_USERNAME: 'qa', ADMIN_PASSWORD: 'qa-admin-only',
        MIFILE_USER: 'alternate@example.com', MIFILE_PASSWORD: 'qa-mifile-only',
        MIFILE_CREDENTIALS_KEY: 'ab'.repeat(32), NODE_ENV: 'test',
    });
    const { getWorkflowDatabase } = require('./database') as typeof import('./database');
    const { buildFilingIntake } = require('./filingIntake') as typeof import('./filingIntake');
    const db = getWorkflowDatabase();
    const storedFiles = new Map<string, Buffer>();
    const drive = require('./oneDriveClient');
    drive.ensureIntakeFolder = async () => ({ driveId: 'fixture-drive', itemId: 'fixture-folder' });
    drive.uploadFileBufferToFolder = async (_driveId: string, _folder: string, name: string, buffer: Buffer) => {
        storedFiles.set(name, buffer);
        return { driveId: 'fixture-drive', itemId: name, fileName: name };
    };
    drive.createFileLink = async (_driveId: string, itemId: string) => `https://onedrive.example/${encodeURIComponent(itemId)}`;
    drive.resolveSharedDriveItem = async (url: string) => ({ driveId: 'fixture-drive', itemId: decodeURIComponent(url.split('/').pop()!), parentItemId: 'fixture-folder', fileName: 'Advice.pdf' });
    drive.downloadDriveItemBuffer = async (_driveId: string, itemId: string) => storedFiles.get(itemId);
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
        await page.locator('[data-draft-field="courtName"]').fill('MI Example County - 25th District Court');
        await page.locator('#draftSaveBtn').click();
        await page.waitForFunction(() => document.getElementById('draftDocumentSelect')?.textContent?.includes('Local'));
        assert.equal(db.getDraftDetail(draftId)!.documents.length, 2);
        const local = db.getDraftDetail(draftId)!.documents.find(doc => doc.formTemplate?.role === 'local')!;
        await page.locator('#draftDocumentSelect').selectOption(local.id);
        assert.equal(await page.locator('#draftReplaceDocumentBtn').isDisabled(), true);
        const applied = page.waitForResponse(response => response.url().endsWith('/standard-forms') && response.status() === 200);
        await page.locator('#draftLibraryBtn').click();
        await applied;
        assert.equal(db.getDraftDetail(draftId)!.documents.length, 2);
        page.once('dialog', dialog => dialog.accept());
        const removed = page.waitForResponse(response => response.url().includes('/library-documents/') && response.status() === 200);
        await page.locator('#draftRemoveFormBtn').click();
        await removed;
        assert.equal(db.getDraftDetail(draftId)!.documents.length, 1);
        assert.equal(storedFiles.size, 2, 'Removing a library document must not delete its OneDrive copy');
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
        assert.equal(manual.caseDraft.status, 'needs_review');
        assert.equal(db.queueValidatedIntakes(), 0);
        await page.locator('#draftWorkspaceView').waitFor({state:'visible'});
        assert.deepEqual(errors, []);
        await page.locator('#signOutBtn').click();
        await page.waitForURL(url + '/login');
        assert.equal((await context.request.get(`${url}/api/settings`)).status(), 401);
        await page.goto(url);
        await page.locator('#loginForm').waitFor();
        console.log('Admin smoke passed: login/logout, settings, form library upload/preview, content recognition, automatic court form, idempotency, PDF preview, desktop/mobile layouts.');
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
