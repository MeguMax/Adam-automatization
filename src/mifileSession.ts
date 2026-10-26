import { chromium, Browser, Page, LaunchOptions } from 'playwright';
import { getMiFileCredentials, MiFileCredentials, miFileCredentialIdentity } from './mifileAccountSettings';

let browser: Browser | null = null;
let cachedCookieHeader: { value: string; createdAt: number; identity: string } | null = null;
let cookieRefreshPromise: Promise<string> | null = null;
let cookieRefreshIdentity: string | null = null;

function boundedEnvironmentInteger(
    value: string | undefined,
    fallback: number,
    min: number,
    max: number,
): number {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) return fallback;
    return Math.min(Math.max(Math.floor(parsed), min), max);
}

const MIFILE_LOGIN_TIMEOUT_MS = boundedEnvironmentInteger(
    process.env.MIFILE_LOGIN_TIMEOUT_MS,
    30_000,
    5_000,
    120_000,
);
const MIFILE_COOKIE_CACHE_MS = boundedEnvironmentInteger(
    process.env.MIFILE_COOKIE_CACHE_MS,
    10 * 60 * 1000,
    30_000,
    60 * 60 * 1000,
);
const MIFILE_LOGIN_ATTEMPTS = boundedEnvironmentInteger(
    process.env.MIFILE_LOGIN_ATTEMPTS,
    2,
    1,
    3,
);

async function getBrowser(): Promise<Browser> {
    if (!browser || !browser.isConnected()) {
        browser = await chromium.launch({
            headless: true,
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--disable-gpu',
            ],
        });
    }
    return browser;
}

async function waitForAuthenticatedCookies(page: Page): Promise<void> {
    const deadline = Date.now() + MIFILE_LOGIN_TIMEOUT_MS;
    while (Date.now() < deadline) {
        const cookies = await page.context().cookies('https://mifile.courts.michigan.gov');
        if (cookies.some(cookie => cookie.name.startsWith('.AspNetCore.Identity.Application'))) {
            return;
        }
        await page.waitForTimeout(400);
    }
    throw new Error(
        `MiFILE login did not create an authenticated session within ${MIFILE_LOGIN_TIMEOUT_MS} ms`,
    );
}

export async function dismissMifileModalIfAny(page: Page): Promise<void> {
    const dialog = page.locator('div[role="dialog"], div[uib-modal-window]');
    const count = await dialog.count();
    if (!count) return;

    let visibleDialog = null;
    for (let index = 0; index < count; index += 1) {
        const candidate = dialog.nth(index);
        if (await candidate.isVisible().catch(() => false)) {
            visibleDialog = candidate;
            break;
        }
    }
    if (!visibleDialog) return;

    const buttons = visibleDialog.locator(
        'button:has-text("OK"), button:has-text("Close"), button.close, ' +
        'button[aria-label="Close"], [data-dismiss="modal"], ' +
        '[ng-click*="$dismiss"], [ng-click*="$close"]'
    );
    if (await buttons.count()) {
        await buttons.first().click({ force: true }).catch(() => {});
        await page.waitForTimeout(500);
        if (!(await visibleDialog.isVisible().catch(() => false))) return;
    }

    await page.keyboard.press('Escape').catch(() => {});
    await page.waitForTimeout(500);
    if (!(await visibleDialog.isVisible().catch(() => false))) return;

    // MiFILE occasionally serves an informational Angular modal without a
    // working dismiss control. Remove only that visible notice and its modal
    // backdrop so it cannot block the filing controls underneath.
    await visibleDialog.evaluate(dialogElement => {
        dialogElement.remove();
        document.querySelectorAll('.modal-backdrop').forEach(backdrop => backdrop.remove());
        document.body.classList.remove('modal-open');
        document.body.style.removeProperty('padding-right');
    }).catch(() => {});
    await page.waitForTimeout(250);
}

export class MiFileNoticeRequiresReviewError extends Error {}

export async function dismissMifilePreparationNotice(page: Page): Promise<void> {
    const news = page.getByText('TrueFiling Notification', { exact: true })
        .locator('xpath=ancestor::div[.//button[normalize-space()="OK"]][1]');
    const dialogs = page.locator('div[role="dialog"], div[uib-modal-window], .ui-dialog').or(news);
    for (let handled = 0; handled < 4; handled++) {
        const dialog = dialogs.filter({ visible: true }).first();
        if (!await dialog.count()) return;
        let text = '';
        const deadline = Date.now() + 5_000;
        // Angular renders the backdrop and empty dialog before loading its content.
        while (await dialog.isVisible() && Date.now() < deadline) {
            text = (await dialog.innerText()).trim();
            if (text && !/^(?:TrueFiling Notification\s*)?(?:OK)?$/i.test(text)) break;
            await page.waitForTimeout(100);
        }
        if (!await dialog.isVisible()) continue;
        const knownInformation = text.includes('Do any of your public documents contain Protected Personal Identifying Information (PII)?') ||
            (text.includes('TrueFiling Notification') && text.includes('New Courts Going Live on MiFILE'));
        if (!knownInformation ||
            /\b(accept|agree|authorize|payment|consent|terms of (?:use|service))\b/i.test(text)) {
            throw new MiFileNoticeRequiresReviewError('MiFILE displayed an unexpected notice. Review it manually before preparation continues.');
        }
        const element = await dialog.elementHandle();
        try {
            await dialog.getByRole('button', { name: 'OK', exact: true }).click();
            await page.waitForFunction(el => !el || !el.isConnected || !el.getClientRects().length ||
                getComputedStyle(el).visibility === 'hidden', element);
        } finally { await element?.dispose(); }
    }
    if (await dialogs.filter({ visible: true }).count()) {
        throw new MiFileNoticeRequiresReviewError('MiFILE displayed repeated notices. Review them manually before preparation continues.');
    }
}

export async function clickMifilePreparationSignIn(page: Page): Promise<void> {
    const button = page.locator('button.flatButton.login-button');
    await dismissMifilePreparationNotice(page);
    try {
        await button.click({ trial: true, timeout: 2_000 });
    } catch {
        // The court-news notice is loaded asynchronously after the login form.
        await dismissMifilePreparationNotice(page);
        await button.click({ trial: true, timeout: 5_000 });
    }
    await dismissMifilePreparationNotice(page);
    await button.click();
}

export async function authenticateMifilePage(
    page: Page,
    credentials = getMiFileCredentials(),
    options: { strictNotices?: boolean } = {},
): Promise<void> {
    if (!credentials.username || !credentials.password) {
        throw new Error('MIFILE_USER / MIFILE_PASSWORD not set in env');
    }

    let lastError: unknown = null;
    for (let attempt = 1; attempt <= MIFILE_LOGIN_ATTEMPTS; attempt += 1) {
        if (attempt > 1) await page.waitForTimeout(5_000);
        try {
            await page.goto(
                'https://mifile.courts.michigan.gov/login?returnurl=%2Fcases',
                {
                    waitUntil: 'load',
                    timeout: 60_000,
                },
            );
            if (options.strictNotices) await dismissMifilePreparationNotice(page);
            else await dismissMifileModalIfAny(page);
            await page.fill('input#Email', credentials.username);
            await page.fill('input#Password', credentials.password);
            if (options.strictNotices) await clickMifilePreparationSignIn(page);
            else await page.locator('button.flatButton.login-button').click({ force: true });
            await waitForAuthenticatedCookies(page);
            return;
        } catch (error) {
            if (error instanceof MiFileNoticeRequiresReviewError) throw error;
            lastError = error;
        }
    }
    console.error('MiFILE sign-in exhausted automatic attempts:', lastError);
    throw new Error('MiFILE sign-in failed or timed out. Check the account and any verification requirements.');
}

/**
 * Возвращает заголовок Cookie для домена MiFILE после логина.
 */
async function createMifileCookieHeader(credentials: MiFileCredentials): Promise<string> {
    const br = await getBrowser();
    const page = await br.newPage();
    try {
        await authenticateMifilePage(page, credentials);
        const cookies = await page.context().cookies('https://mifile.courts.michigan.gov');
        const cookieHeader = cookies.map(c => `${c.name}=${c.value}`).join('; ');
        if (!cookieHeader) throw new Error('MiFILE login returned an empty cookie set');
        cachedCookieHeader = { value: cookieHeader, createdAt: Date.now(), identity: miFileCredentialIdentity(credentials) };
        return cookieHeader;
    } finally {
        await page.close().catch(() => {});
    }
}

export function invalidateMifileSession(): void {
    cachedCookieHeader = null;
}

export async function getMifileCookieHeader(forceRefresh = false): Promise<string> {
    const credentials = getMiFileCredentials();
    const identity = miFileCredentialIdentity(credentials);
    if (
        !forceRefresh &&
        cachedCookieHeader &&
        cachedCookieHeader.identity === identity &&
        Date.now() - cachedCookieHeader.createdAt < MIFILE_COOKIE_CACHE_MS
    ) {
        return cachedCookieHeader.value;
    }
    if (cookieRefreshPromise && cookieRefreshIdentity === identity) return cookieRefreshPromise;

    const refresh = createMifileCookieHeader(credentials);
    cookieRefreshPromise = refresh;
    cookieRefreshIdentity = identity;
    try {
        return await refresh;
    } finally {
        if (cookieRefreshPromise === refresh) cookieRefreshPromise = null;
    }
}

export async function testMiFileCredentials(credentials: MiFileCredentials): Promise<void> {
    const testBrowser = await chromium.launch({
        headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'],
    });
    try {
        const page = await testBrowser.newPage();
        await authenticateMifilePage(page, credentials, { strictNotices: true });
    } catch {
        throw new Error('MiFILE sign-in could not be verified. Check the credentials, service availability, or additional verification requirements.');
    } finally {
        await testBrowser.close();
    }
}

export async function closeMifileBrowser(): Promise<void> {
    cachedCookieHeader = null;
    cookieRefreshPromise = null;
    if (browser) {
        await browser.close();
        browser = null;
    }
}
