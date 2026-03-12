// test-truecertify.ts
import { downloadTrueCertifyDocument } from './src/truecertifyDownloader';
import * as path from 'path';
import * as fs from 'fs';

async function test() {
    console.log('🚀 Тестирование TrueCertify загрузчика');
    console.log('=====================================');

    const locator = "MIP63-S2HGMQ-FF7DC1F3";
    const publicKey = "3A7";

    const downloadDir = path.join(process.cwd(), 'test_downloads');
    const debugDir = path.join(process.cwd(), 'temp', 'captcha_debug');

    // Создаем папки
    [downloadDir, debugDir].forEach(dir => {
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }
    });

    console.log(`📁 Папка загрузок: ${downloadDir}`);
    console.log(`🔍 Папка отладки: ${debugDir}`);
    console.log(`🔑 Локатор: ${locator}`);
    console.log(`🔐 Ключ: ${publicKey}`);
    console.log('=====================================');

    try {
        const startTime = Date.now();

        const result = await downloadTrueCertifyDocument(
            locator,
            publicKey,
            downloadDir,
            false
        );

        const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

        console.log('=====================================');
        if (result.success) {
            console.log('✅ УСПЕХ!');
            console.log(`📄 Файл: ${result.fileName}`);
            console.log(`📍 Путь: ${result.filePath}`);
            console.log(`⏱ Время: ${elapsed} сек`);

            // Проверяем размер
            const stats = fs.statSync(result.filePath!);
            console.log(`📊 Размер: ${stats.size} байт (${(stats.size / 1024).toFixed(1)} KB)`);
        } else {
            console.log('❌ НЕУДАЧА');
            console.log(`Ошибка: ${result.error}`);
        }
        console.log('=====================================');
    } catch (error) {
        console.error('❌ Критическая ошибка:', error);
    }
}

test().catch(console.error);