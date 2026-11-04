import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { chromium } from 'playwright';

async function main() {
    const cwd = process.cwd();
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'batch-admin-smoke-'));
    const output = path.join(cwd, 'output', 'batch-intake-2026-11-04', 'ui');
    fs.mkdirSync(output, { recursive: true });
    process.chdir(directory);
    Object.assign(process.env, { TENANT_ID: '11111111-1111-1111-1111-111111111111', CLIENT_ID: 'qa', CLIENT_SECRET: 'qa-only',
        USER_EMAIL: 'qa@example.com', ONEDRIVE_ROOT_SHARE_URL: 'https://onedrive.example/root',
        WORKFLOW_DB_PATH: path.join(directory, 'workflow.sqlite'), ADMIN_SYNC_ENABLED: 'false',
        ADMIN_USERNAME: 'qa', ADMIN_PASSWORD: 'qa-only-test', NODE_ENV: 'test', DRAFT_READY_NOTIFICATIONS_ENABLED: 'false' });
    const { getWorkflowDatabase } = require('./database') as typeof import('./database');
    const { buildFilingIntake } = require('./filingIntake') as typeof import('./filingIntake');
    const db = getWorkflowDatabase();
    const message = { id: 'batch-qa-ui', subject: 'NEW LT FILING - QA two cases', from: { emailAddress: { address: 'qa@example.com' } } };
    const email = db.registerEmail(message);
    const packages = db.createCaseDrafts(email.id, buildFilingIntake(message, ['Demo D', 'Example E'].flatMap(prefix =>
        ['Complaint', 'Summons', 'Request', 'Demand'].map(role => ({ id: prefix + role, name: `${prefix} ${role}.pdf`,
            contentType: 'application/pdf', size: 100, isInline: false })))));
    db.markEmailProcessed(email.id);
    for (const item of packages) db.refreshCaseDraftValidation(item.draftId);
    const { createAdminServer } = require('./adminServer') as typeof import('./adminServer');
    const server = createAdminServer(0, { handleSignals: false, closeDatabaseOnShutdown: false, filingWorkerAvailable: () => false });
    await once(server, 'listening');
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({ viewport: { width: 1440, height: 1024 } });
    const page = await context.newPage();
    const errors: string[] = [];
    const external: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    await context.route('**/*', route => {
        if (route.request().url().startsWith(base + '/')) return route.continue();
        external.push(route.request().url()); return route.abort();
    });
    try {
        await page.goto(base + '/?draft=' + packages[0].draftId);
        await page.locator('#username').fill('qa');
        await page.locator('#password').fill('qa-only-test');
        await page.locator('#signIn').click();
        await page.locator('#draftWorkspaceView:not(.hidden)').waitFor();
        assert.match(await page.locator('#draftWorkspaceCase').innerText(), /Demo D/);
        assert.equal(await page.locator('#draftDocumentSelect option').count(), 4);
        await page.locator('#draftDocumentsTab').click();
        const support = db.getDraftDetail(packages[0].draftId)!.documents.find(document => document.packageRole === 'ancillary')!;
        await page.locator(`[data-disclosure="document-${support.id}"] > summary`).click();
        await page.locator(`[data-move-target="${support.id}"]`).selectOption(packages[1].draftId);
        assert.equal(await page.locator('#draftSaveBtn').isEnabled(), false);
        await page.locator(`[data-move-supporting="${support.id}"]`).scrollIntoViewIfNeeded();
        await page.screenshot({ path: path.join(output, 'desktop-batch-draft.png'), fullPage: true });
        page.once('dialog', dialog => dialog.accept());
        const moved = page.waitForResponse(response => response.url().endsWith('/move') && response.request().method() === 'POST');
        await page.locator(`[data-move-supporting="${support.id}"]`).click();
        assert.equal((await moved).status(), 200);
        await page.waitForFunction(() => document.querySelectorAll('#draftDocumentSelect option').length === 3);
        assert.equal(db.getDraftDetail(packages[1].draftId)!.documents.length, 5);
        await page.goto(base);
        await page.locator('#queue tr[data-id]').first().waitFor();
        assert.equal(await page.locator('#queue tr[data-id]').count(), 1);
        await page.locator('#queue tr[data-id]').first().click();
        await page.getByText('Cases in this email', { exact: true }).waitFor();
        assert.equal(await page.locator('#detail [data-open-detail-draft]').count(), 2);
        await page.screenshot({ path: path.join(output, 'desktop-email-packages.png'), fullPage: true });
        await page.locator('#settingsTab').click();
        await page.getByText('Multiple cases per email', { exact: false }).waitFor();
        await page.locator('#draftReadyNotifications').waitFor();
        await page.setViewportSize({ width: 390, height: 844 });
        await page.goto(base + '/?draft=' + packages[1].draftId);
        await page.locator('#draftWorkspaceView:not(.hidden)').waitFor();
        assert.match(await page.locator('#draftWorkspaceCase').innerText(), /Example E/);
        await page.screenshot({ path: path.join(output, 'mobile-batch-draft.png'), fullPage: true });
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), true);
        assert.deepEqual(errors, []); assert.deepEqual(external, []);
        assert.equal(db.listFilingJobs().length, 0);
        console.log('Batch UI smoke passed: login deep link, case-scoped documents, safe PDF move, email sibling navigation, settings and mobile layout. No external requests or MiFILE jobs.');
    } finally {
        await browser.close();
        await new Promise<void>(resolve => server.close(() => resolve()));
        db.close(); process.chdir(cwd);
        fs.rmSync(directory, { recursive: true, force: true });
    }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
