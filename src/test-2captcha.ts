import { downloadTrueCertifyDocument } from './truecertifyDownloader';
import * as path from 'path';
import * as fs from 'fs';
import * as dotenv from 'dotenv';

// Загружаем переменные окружения
dotenv.config();

async function testWith2Captcha() {
    const API_KEY = process.env.TWO_CAPTCHA_API_KEY;
    if (!API_KEY) {
        throw new Error('❌ API ключ 2Captcha не найден в .env файле!');
    }

    console.log('🚀 Тестирование TrueCertify с 2Captcha');
    console.log('=====================================');

    const locator = "MIP63-S2HGMQ-FF7DC1F3";
    const publicKey = "3A7";
    const downloadDir = path.join(process.cwd(), 'test_downloads');

    // Создаём папку для загрузок
    if (!fs.existsSync(downloadDir)) {
        fs.mkdirSync(downloadDir, { recursive: true });
    }

    console.log(`🔑 Локатор: ${locator}`);
    console.log(`🔐 Ключ: ${publicKey}`);
    console.log(`🤖 Используем: 2Captcha`);
    console.log('=====================================');

    try {
        const startTime = Date.now();

        const result = await downloadTrueCertifyDocument(
            locator,
            publicKey,
            downloadDir,
            false,  // headless = false для отладки
            API_KEY
        );

        const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

        if (result.success) {
            console.log('✅ УСПЕХ!');
            console.log(`📄 Файл: ${result.fileName}`);
            console.log(`📍 Путь: ${result.filePath}`);
            console.log(`⏱ Время: ${elapsed} сек`);

            const stats = fs.statSync(result.filePath!);
            console.log(`📊 Размер: ${stats.size} байт (${(stats.size / 1024).toFixed(1)} KB)`);
        } else {
            console.log('❌ НЕУДАЧА:', result.error);
        }
    } catch (error) {
        console.error('❌ Ошибка:', error);
    }
}

testWith2Captcha();