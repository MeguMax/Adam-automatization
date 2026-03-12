import { chromium, Browser, Page } from 'playwright';

const MIFILE_USER = process.env.MIFILE_USER!;
const MIFILE_PASSWORD = process.env.MIFILE_PASSWORD!;

let browser: Browser | null = null;

async function getBrowser(): Promise<Browser> {
    if (!browser) {
        browser = await chromium.launch({
            headless: true, // можно временно false для отладки
        });
    }
    return browser;
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
    await page.waitForTimeout(3000);
}

/**
 * Возвращает заголовок Cookie для домена MiFILE после логина.
 */
export async function getMifileCookieHeader(): Promise<string> {
    const br = await getBrowser();
    const page = await br.newPage();

    await loginToMifile(page);

    const cookies = await page.context().cookies('https://mifile.courts.michigan.gov');
    const cookieHeader = cookies.map(c => `${c.name}=${c.value}`).join('; ');

    await page.close();
    return cookieHeader;
}

export async function closeMifileBrowser(): Promise<void> {
    if (browser) {
        await browser.close();
        browser = null;
    }
}
