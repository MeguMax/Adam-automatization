import * as fs from 'fs';
import * as path from 'path';

async function analyzeHtmlFile(filePath: string) {
    console.log(`Анализ файла: ${filePath}`);
    console.log('='.repeat(50));

    try {
        const html = await fs.promises.readFile(filePath, 'utf-8');

        // Проверяем заголовок страницы
        const titleMatch = html.match(/<title>(.*?)<\/title>/i);
        if (titleMatch) {
            console.log(`📌 Заголовок: ${titleMatch[1]}`);
        }

        // Проверяем сообщения об ошибках
        if (html.includes('Invalid captcha') || html.includes('Invalid CAPTCHA')) {
            console.log('❌ Найдено сообщение: Invalid CAPTCHA');
        }

        if (html.includes('The captcha code you entered is incorrect')) {
            console.log('❌ Найдено сообщение: The captcha code you entered is incorrect');
        }

        if (html.includes('CAPTCHA is invalid')) {
            console.log('❌ Найдено сообщение: CAPTCHA is invalid');
        }

        // Проверяем наличие формы с капчей
        if (html.includes('CaptchaValue') || html.includes('captcha')) {
            console.log('⚠️ На странице снова есть поле для капчи');
        }

        // Ищем PDF ссылки
        const pdfLinks = html.match(/https?:\/\/[^\s"']+\.pdf[^\s"']*/g) || [];
        if (pdfLinks.length > 0) {
            console.log(`\n📄 Найдено PDF ссылок: ${pdfLinks.length}`);
            pdfLinks.forEach((link, i) => {
                console.log(`   ${i+1}. ${link}`);
            });
        } else {
            console.log('\n📄 PDF ссылок не найдено');
        }

        // Ищем кнопки скачивания (без флага /s)
        const downloadButtons = [];
        const buttonRegex = /<a[^>]*>(?:Download|View|Скачать)[^<]*<\/a>/gi;
        let match;
        while ((match = buttonRegex.exec(html)) !== null) {
            downloadButtons.push(match[0]);
        }

        if (downloadButtons.length > 0) {
            console.log(`\n🔘 Найдено кнопок скачивания: ${downloadButtons.length}`);
            downloadButtons.forEach((btn, i) => {
                console.log(`   ${i+1}. ${btn.substring(0, 100)}...`);
            });
        }

        // Ищем формы (без флага /s)
        const forms = [];
        const formRegex = /<form[^>]*>.*?<\/form>/gi;
        while ((match = formRegex.exec(html)) !== null) {
            forms.push(match[0]);
        }
        console.log(`\n📝 Найдено форм: ${forms.length}`);

        // Проверяем наличие успешного сообщения
        if (html.includes('Document ready') || html.includes('document is ready') ||
            html.includes('Download your document') || html.includes('Your document is ready')) {
            console.log('✅ Найдено сообщение об успешной загрузке документа');
        }

        // Проверяем наличие кнопки "Back" или "Try again"
        if (html.includes('Try again') || html.includes('Back')) {
            console.log('🔄 Найдена кнопка повторной попытки');
        }

        // Проверяем размер файла
        const stats = fs.statSync(filePath);
        console.log(`\n📊 Размер файла: ${stats.size} байт`);

        if (stats.size < 1000) {
            console.log('⚠️ Файл очень маленький, возможно это ошибка или редирект');
        }

        // Показываем первые 300 символов HTML для понимания
        console.log('\n📄 Первые 300 символов HTML:');
        console.log(html.substring(0, 300));

    } catch (error) {
        console.error('❌ Ошибка при чтении файла:', error);
    }
}

// Получаем путь к файлу из аргументов командной строки
const filePath = process.argv[2];
if (!filePath) {
    console.log('Укажите путь к HTML файлу:');
    console.log('Пример: npx ts-node analyze-html.ts temp/captcha_debug/response_1772153196457.html');
    process.exit(1);
}

analyzeHtmlFile(filePath).catch(console.error);