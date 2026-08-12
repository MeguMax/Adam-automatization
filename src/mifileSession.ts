import { chromium, Browser, Page, LaunchOptions } from 'playwright';

const MIFILE_USER = process.env.MIFILE_USER!;
const MIFILE_PASSWORD = process.env.MIFILE_PASSWORD!;

let browser: Browser | null = null;
let cachedCookieHeader: { value: string; createdAt: number } | null = null;
let cookieRefreshPromise: Promise<string> | null = null;

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

async function closeLoginModalIfAny(page: Page): Promise<void> {
    const dialog = page.locator('div[role="dialog"], div[uib-modal-window]');
    if (!(await dialog.count())) return;

    const buttons = dialog.locator(
        'button:has-text("OK"), button:has-text("Close"), button.close'
    );
    if (await buttons.count()) {
        await buttons.first().click({ force: true }).catch(() => {});
        await page.waitForTimeout(500);
        return;
    }

    await dialog.first().click({ force: true }).catch(() => {});
    await page.waitForTimeout(500);
}

async function loginToMifile(page: Page): Promise<void> {
    if (!MIFILE_USER || !MIFILE_PASSWORD) {
        throw new Error('MIFILE_USER / MIFILE_PASSWORD not set in env');
    }

    try {
        await page.goto(
            'https://mifile.courts.michigan.gov/login?returnurl=%2Fcases',
            {
                waitUntil: 'load',
                timeout: 60000, // было дефолтные 30000
            }
        );
    } catch (err) {
        console.error('MiFILE login page.goto timeout or error:', err);
        throw err;
    }

    await closeLoginModalIfAny(page);

    await page.fill('input#Email', MIFILE_USER);
    await page.fill('input#Password', MIFILE_PASSWORD);

    const loginButton = page.locator('button.flatButton.login-button');
    await loginButton.click({ force: true });

    // даём немного времени на установку cookies
    await waitForAuthenticatedCookies(page);
}

/**
 * Возвращает заголовок Cookie для домена MiFILE после логина.
 */
async function createMifileCookieHeader(): Promise<string> {
    const br = await getBrowser();
    const page = await br.newPage();
    try {
        await loginToMifile(page);
        const cookies = await page.context().cookies('https://mifile.courts.michigan.gov');
        const cookieHeader = cookies.map(c => `${c.name}=${c.value}`).join('; ');
        if (!cookieHeader) throw new Error('MiFILE login returned an empty cookie set');
        cachedCookieHeader = { value: cookieHeader, createdAt: Date.now() };
        return cookieHeader;
    } finally {
        await page.close().catch(() => {});
    }
}

export function invalidateMifileSession(): void {
    cachedCookieHeader = null;
}

export async function getMifileCookieHeader(forceRefresh = false): Promise<string> {
    if (
        !forceRefresh &&
        cachedCookieHeader &&
        Date.now() - cachedCookieHeader.createdAt < MIFILE_COOKIE_CACHE_MS
    ) {
        return cachedCookieHeader.value;
    }
    if (cookieRefreshPromise) return cookieRefreshPromise;

    const refresh = createMifileCookieHeader();
    cookieRefreshPromise = refresh;
    try {
        return await refresh;
    } finally {
        if (cookieRefreshPromise === refresh) cookieRefreshPromise = null;
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
