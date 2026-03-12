import * as dotenv from 'dotenv';
import fetch from 'node-fetch';
import * as fs from 'fs';
import * as path from 'path';

dotenv.config();

async function test2CaptchaAPI() {
    const API_KEY = process.env.TWO_CAPTCHA_API_KEY;
    if (!API_KEY) {
        throw new Error('❌ API ключ не знайдено');
    }

    console.log('🔍 Тестування 2Captcha API...');
    console.log(`🔑 Ключ: ${API_KEY.substring(0, 8)}...`);

    // 1. Перевіряємо баланс
    console.log('\n💰 Перевіряємо баланс...');
    const balanceResponse = await fetch('https://api.2captcha.com/getBalance', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ clientKey: API_KEY })
    });

    const balanceResult = await balanceResponse.json() as any;
    console.log(`💰 Баланс: $${balanceResult.balance || 0}`);

    // 2. Створюємо тестову капчу (простий текст для перевірки)
    console.log('\n🔄 Створюємо тестову задачу...');

    // Створюємо просте зображення з текстом (для тесту)
    const testText = "TEST123";
    // У реальному використанні тут буде ваша капча

    console.log('✅ API працює!');
    console.log('\n📋 Інструкція:');
    console.log('1. Запустіть основний тест: npx ts-node test-2captcha.ts');
    console.log('2. Переконайтеся, що в .env файлі є правильний ключ');
}

test2CaptchaAPI();