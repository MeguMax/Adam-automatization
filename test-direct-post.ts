import fetch from 'node-fetch';
import * as fs from 'fs';
import * as dotenv from 'dotenv';
import { chromium } from 'playwright';

dotenv.config();

async function testDirectPost() {
    const locator = "MIP63-S2HGMQ-FF7DC1F3";
    const publicKey = "3A7";
    const captchaText = "eNFAy"; // використовуємо текст з попередньої спроби

    console.log('🔍 Тестування прямого POST запиту');
    console.log('=================================');

    // 1. Спочатку отримуємо куки через браузер
    const browser = await chromium.launch({ headless: false });
    const page = await browser.newPage();

    await page.goto(`https://eservices.truecertify.com/?loc=${locator}&key=${publicKey}`);
    await page.waitForTimeout(2000);

    const cookies = await page.context().cookies();
    const cookieString = cookies.map(c => `${c.name}=${c.value}`).join('; ');

    console.log('🍪 Отримано куки:', cookieString);

    // 2. Відправляємо POST запит
    const formData = new URLSearchParams();
    formData.append('DocumentLocator', locator);
    formData.append('PublicKey', publicKey);
    formData.append('CaptchaValue', captchaText);
    formData.append('action', 'Submit');

    const response = await fetch('https://eservices.truecertify.com/', {
        method: 'POST',
        headers: {
            'Accept': 'application/pdf,text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
            'Content-Type': 'application/x-www-form-urlencoded',
            'Cookie': cookieString,
            'Origin': 'https://eservices.truecertify.com',
            'Referer': `https://eservices.truecertify.com/?loc=${locator}&key=${publicKey}`,
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
        },
        body: formData.toString()
    });

    console.log(`📥 Статус: ${response.status}`);
    console.log('📥 Content-Type:', response.headers.get('content-type'));

    const buffer = Buffer.from(await response.arrayBuffer());
    console.log(`📦 Розмір: ${buffer.length} байт`);

    // Зберігаємо результат
    fs.writeFileSync('test_result.bin', buffer);
    console.log('💾 Результат збережено в test_result.bin');

    if (buffer.length > 4) {
        console.log('📝 Перші 100 символів:', buffer.slice(0, 100).toString('utf8'));
    }

    await browser.close();
}

testDirectPost();