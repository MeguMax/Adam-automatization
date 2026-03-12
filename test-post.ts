import fetch from 'node-fetch';
import * as fs from 'fs';

async function testPost() {
    const locator = "MIP63-S2HGMQ-FF7DC1F3";
    const publicKey = "3A7";
    const captchaText = "r234t"; // Текст из последней удачной попытки

    const formData = new URLSearchParams();
    formData.append('DocumentLocator', locator);
    formData.append('PublicKey', publicKey);
    formData.append('CaptchaValue', captchaText);
    formData.append('action', 'Submit');

    console.log('🔄 Отправляем POST запрос...');

    const response = await fetch('https://eservices.truecertify.com/', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
        },
        body: formData.toString()
    });

    console.log(`Статус: ${response.status}`);
    console.log('Content-Type:', response.headers.get('content-type'));

    const buffer = Buffer.from(await response.arrayBuffer());
    console.log(`Получено байт: ${buffer.length}`);

    // Сохраняем результат
    fs.writeFileSync('test_result.bin', buffer);
    console.log('Результат сохранён в test_result.bin');

    // Проверяем сигнатуру
    if (buffer.length > 4) {
        console.log('Первые байты:', buffer.slice(0, 20));
        console.log('Как текст:', buffer.slice(0, 100).toString('utf8'));
    }
}

testPost().catch(console.error);