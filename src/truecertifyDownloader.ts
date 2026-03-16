import { chromium, Browser, Page } from 'playwright';
import fetch from 'node-fetch';
import { TwoCaptchaClient } from './2captcha-client';

export interface TrueCertifyBufferResult {
    success: boolean;
    buffer?: Buffer;
    fileName?: string;
    error?: string;
}

export class TrueCertifyBufferDownloader {
    private browser: Browser | null = null;
    private page: Page | null = null;
    private captchaClient: TwoCaptchaClient;

    constructor(twoCaptchaApiKey: string, debugDir: string = './temp/captcha_debug') {
        this.captchaClient = new TwoCaptchaClient(twoCaptchaApiKey, debugDir);
    }

    private async launch(): Promise<void> {
        if (this.browser) return;

        this.browser = await chromium.launch({
            headless: true,
            args: ['--disable-blink-features=AutomationControlled', '--disable-web-security'],
        });

        const context = await this.browser.newContext({
            viewport: { width: 1280, height: 720 },
            userAgent:
                'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
        });

        this.page = await context.newPage();

        await this.page.addInitScript(`
            Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
        `);
    }

    async downloadToBuffer(locator: string, publicKey: string): Promise<TrueCertifyBufferResult> {
        try {
            await this.launch();
            if (!this.page) throw new Error('Browser/page not initialized');

            const url = `https://eservices.truecertify.com/?loc=${encodeURIComponent(
                locator
            )}&key=${encodeURIComponent(publicKey)}`;
            console.log('TrueCertify URL:', url);

            await this.page.goto(url, { waitUntil: 'networkidle', timeout: 30000 });

            const MAX_ATTEMPTS = 7;

            for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
                console.log(`TrueCertify attempt ${attempt}/${MAX_ATTEMPTS}`);

                const captchaImg = await this.page.$('.tc-image-container img');
                if (!captchaImg) throw new Error('Captcha image not found');

                const imgSrc = await captchaImg.getAttribute('src');
                if (!imgSrc) throw new Error('Captcha src not found');

                const imgUrl = imgSrc.startsWith('/')
                    ? `https://eservices.truecertify.com${imgSrc}`
                    : imgSrc;

                const imgResponse = await fetch(imgUrl);
                const imageBuffer = Buffer.from(await imgResponse.arrayBuffer());

                const captchaText = await this.captchaClient.solveImage(imageBuffer);
                if (!captchaText || captchaText.length < 3) {
                    console.log('Captcha empty/too short, reloading page...');
                    await this.page.reload({ waitUntil: 'networkidle' });
                    await this.page.waitForTimeout(2000);
                    continue;
                }

                console.log(`Captcha solved: ${captchaText}`);

                await this.page.fill('#CaptchaValue', '').catch(() => {});
                await this.page.waitForTimeout(200);
                await this.page.fill('#CaptchaValue', captchaText);
                await this.page.waitForTimeout(300);

                const submitButton = await this.page.$('.tc-submit');
                if (!submitButton) {
                    throw new Error('Submit button not found');
                }

                console.log('Waiting for download event...');

                try {
                    const [download] = await Promise.all([
                        this.page.waitForEvent('download', { timeout: 20000 }),
                        (async () => {
                            await submitButton.click();
                            // небольшая пауза после клика, чтобы сервер успел инициировать выдачу файла
                            await this.page!.waitForTimeout(1000);
                        })(),
                    ]);

                    // на всякий случай ещё немного ждём перед чтением стрима
                    await this.page!.waitForTimeout(500);

                    const stream = await download.createReadStream();
                    if (!stream) throw new Error('No download stream');

                    const chunks: Buffer[] = [];
                    await new Promise<void>((resolve, reject) => {
                        stream.on('data', c => chunks.push(c));
                        stream.on('end', () => resolve());
                        stream.on('error', err => reject(err));
                    });

                    const buffer = Buffer.concat(chunks);
                    console.log(`TrueCertify PDF buffer size: ${buffer.length}`);

                    if (buffer.length <= 10_000) {
                        console.log('Downloaded buffer too small, retrying...');
                        await this.page!.reload({ waitUntil: 'networkidle' });
                        await this.page!.waitForTimeout(2000);
                        continue;
                    }

                    const fileName = `truecertify_${locator}_${Date.now()}.pdf`;
                    return { success: true, buffer, fileName };
                } catch (e) {
                    console.log('Download failed in this attempt, reloading...', e);
                    await this.page!.reload({ waitUntil: 'networkidle' });
                    await this.page!.waitForTimeout(2000);
                }
            }

            throw new Error('Failed to download TrueCertify PDF after several attempts');
        } catch (error) {
            console.error('TrueCertify buffer download error:', error);
            return {
                success: false,
                error: error instanceof Error ? error.message : 'Unknown error',
            };
        }
    }

    async close(): Promise<void> {
        if (this.browser) {
            await this.browser.close();
            this.browser = null;
            this.page = null;
        }
    }
}
