import { chromium } from 'playwright';
import { solveRecaptcha, hasRecaptcha, waitForManualRecaptcha } from './src/recaptcha-solver';
import * as fs from 'fs';
import * as path from 'path';

async function test() {
    console.log('🚀 Тестирование бесплатного решения reCAPTCHA');
    console.log('=====================================');

    const locator = "MIP63-S2HGMQ-FF7DC1F3";
    const publicKey = "3A7";
    const downloadDir = path.join(process.cwd(), 'test_downloads');

    if (!fs.existsSync(downloadDir)) {
        fs.mkdirSync(downloadDir, { recursive: true });
    }

    // Запускаем браузер с дополнительными аргументами
    const browser = await chromium.launch({
        headless: false,
        args: [
            '--disable-blink-features=AutomationControlled',
            '--disable-web-security',
            '--disable-features=IsolateOrigins,site-per-process'
        ]
    });

    try {
        const context = await browser.newContext({
            viewport: { width: 1280, height: 720 },
            userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
        });

        const page = await context.newPage();

        // Добавляем скрипт для обхода детекта ботов
        await page.addInitScript(() => {
            Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
        });

        const url = `https://eservices.truecertify.com/?loc=${locator}&key=${publicKey}`;
        console.log(`🌐 Переходим на: ${url}`);

        await page.goto(url, { waitUntil: 'networkidle' });

        // Переключаемся на reCAPTCHA если доступно
        const switchLink = await page.$('a:has-text("Switch to accessible captcha")');
        if (switchLink) {
            console.log('🔄 Переключаемся на reCAPTCHA...');
            await switchLink.click();
            await page.waitForTimeout(3000);
        }

        // Проверяем наличие reCAPTCHA
        const recaptchaExists = await hasRecaptcha(page);

        if (!recaptchaExists) {
            throw new Error('reCAPTCHA не найдена на странице');
        }

        console.log('\n📌 Выберите метод решения:');
        console.log('1. Автоматический (имитация клика)');
        console.log('2. Ручной (решите сами в браузере)');
        console.log('3. Пропустить (если капчи нет)');

        // Здесь можно добавить выбор метода, но для теста попробуем автоматический
        const solved = await solveRecaptcha(page);

        if (!solved) {
            console.log('⚠️ Автоматическое решение не сработало, пробуем ручной режим...');
            const manualSolved = await waitForManualRecaptcha(page, 30000);

            if (!manualSolved) {
                throw new Error('Капча не решена');
            }
        }

        // Ждем немного
        await page.waitForTimeout(2000);

        // Нажимаем Submit
        console.log('⏳ Отправляем форму...');
        const submitButton = await page.$('.tc-submit');

        if (!submitButton) {
            throw new Error('Кнопка Submit не найдена');
        }

        // Ждем ответ
        const [response] = await Promise.all([
            page.waitForResponse(r => r.url().includes('truecertify')),
            submitButton.click()
        ]);

        const contentType = response.headers()['content-type'] || '';
        console.log(`📋 Content-Type: ${contentType}`);

        if (contentType.includes('pdf')) {
            const pdfBuffer = await response.body();
            console.log(`📦 Получено ${pdfBuffer.length} байт`);

            const fileName = `truecertify_${locator}_${Date.now()}.pdf`;
            const filePath = path.join(downloadDir, fileName);
            fs.writeFileSync(filePath, pdfBuffer);

            console.log(`✅ PDF сохранён: ${fileName}`);
        } else {
            console.log('❌ Сервер не вернул PDF');
            const html = await response.text();
            console.log('Первые 200 символов:', html.substring(0, 200));

            // Сохраняем для отладки
            const debugPath = path.join(downloadDir, `debug_${Date.now()}.html`);
            fs.writeFileSync(debugPath, html);
            console.log(`📝 Отладка сохранена: ${debugPath}`);
        }

        await page.waitForTimeout(5000);

    } catch (error) {
        console.error('❌ Ошибка:', error);
    } finally {
        await browser.close();
    }
}

// Запускаем тест
test().catch(console.error);