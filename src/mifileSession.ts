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

export async function authenticateMifilePage(
    page: Page,
    credentials = getMiFileCredentials(),
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
            await dismissMifileModalIfAny(page);
            await page.fill('input#Email', credentials.username);
            await page.fill('input#Password', credentials.password);
            await page.locator('button.flatButton.login-button').click({ force: true });
            await waitForAuthenticatedCookies(page);
            return;
        } catch (error) {
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
        await authenticateMifilePage(page, credentials);
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
