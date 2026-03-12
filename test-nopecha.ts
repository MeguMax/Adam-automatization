import { chromium } from 'playwright';
import * as path from 'path';
import * as fs from 'fs';

async function testNopecha() {
    console.log('🚀 Тестирование NopeCHA расширения');
    console.log('=====================================');

    const extensionPath = path.join(__dirname, 'extensions', 'nopecha');

    if (!fs.existsSync(extensionPath)) {
        console.error('❌ Папка расширения не найдена:', extensionPath);
        return;
    }

    console.log('✅ Папка расширения найдена');

    const context = await chromium.launchPersistentContext('', {
        headless: false,
        args: [
            `--disable-extensions-except=${extensionPath}`,
            `--load-extension=${extensionPath}`,
            '--disable-blink-features=AutomationControlled'
        ],
        viewport: { width: 1280, height: 720 }
    });

    try {
        const page = await context.newPage();

        await page.addInitScript(() => {
            Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
        });

        const locator = "MIP63-S2HGMQ-FF7DC1F3";
        const publicKey = "3A7";
        const url = `https://eservices.truecertify.com/?loc=${locator}&key=${publicKey}`;

        console.log(`\n🌐 Переходим на: ${url}`);
        await page.goto(url, { waitUntil: 'networkidle' });

        await page.waitForTimeout(2000);

        console.log('\n🔄 Ищем ссылку на reCAPTCHA...');
        const switchLink = await page.$('a:has-text("Switch to accessible captcha")');

        if (switchLink) {
            console.log('✅ Нашли ссылку, переключаемся...');
            await switchLink.click();
            await page.waitForTimeout(3000);
        } else {
            console.log('❌ Ссылка не найдена');
        }

        console.log('\n⏳ Ожидаем решение капчи расширением NopeCHA...');
        console.log('👆 Наблюдайте за процессом в браузере');

        const maxWaitTime = 120;
        let solved = false;

        for (let i = 0; i < maxWaitTime; i++) {
            // 1. Проверяем, что чекбокс отмечен внутри iframe
            const isCheckboxChecked = await page.evaluate(() => {
                const frames = document.querySelectorAll('iframe[src*="recaptcha"]');
                for (const frame of frames) {
                    try {
                        // @ts-ignore - пробуем получить документ внутри iframe
                        const iframeDoc = frame.contentDocument || frame.contentWindow?.document;
                        if (iframeDoc) {
                            const checked = iframeDoc.querySelector('.recaptcha-checkbox-checked');
                            if (checked) return true;
                        }
                    } catch (e) {
                        // Игнорируем ошибки доступа к iframe
                    }
                }
                return false;
            });

            // 2. Проверяем, появился ли токен в скрытом поле (САМЫЙ ВАЖНЫЙ ПРИЗНАК)
            const hasToken = await page.evaluate(() => {
                const textarea = document.getElementById('g-recaptcha-response');
                return textarea && textarea.innerHTML.length > 10;
            });

            // 3. Проверка активности кнопки (запасной вариант)
            const submitButton = await page.$('.tc-submit');
            const isSubmitEnabled = submitButton ? await submitButton.isEnabled() : false;

            // Если есть признаки решения
            if (isCheckboxChecked || hasToken || isSubmitEnabled) {
                // Даем дополнительную секунду на обработку
                await page.waitForTimeout(1000);

                // Финальная проверка: есть ли токен?
                const finalTokenCheck = await page.evaluate(() => {
                    const textarea = document.getElementById('g-recaptcha-response');
                    return textarea && textarea.innerHTML.length > 10;
                });

                if (finalTokenCheck) {
                    console.log(`\n✅ Капча полностью решена на ${i + 1} секунде (токен получен)!`);
                    solved = true;
                    break;
                } else {
                    console.log(`⏳ Капча выглядит решённой, но токен ещё не появился... ждём.`);
                }
            }

            if (i % 10 === 0) {
                console.log(`⏳ Ожидание... ${i}/${maxWaitTime} сек (токен: ${hasToken ? 'есть' : 'нет'})`);
            }

            await page.waitForTimeout(1000);
        }

        if (solved) {
            console.log('🎉 Капча успешно решена!');

            // Даем время на обработку
            await page.waitForTimeout(2000);

            console.log('\n🔍 Проверяем кнопку Submit...');
            const submitButton = await page.$('.tc-submit');

            if (submitButton) {
                const isEnabled = await submitButton.isEnabled();
                console.log(`Кнопка Submit ${isEnabled ? 'активна' : 'неактивна'}`);

                if (isEnabled) {
                    console.log('⏳ Нажимаем Submit...');

                    // Сохраняем куки из браузера перед запросом
                    const cookies = await context.cookies();
                    const cookieString = cookies.map(c => `${c.name}=${c.value}`).join('; ');

                    // Нажимаем кнопку
                    await submitButton.click();

                    // Ждем немного, чтобы запрос ушёл
                    await page.waitForTimeout(3000);

                    // Получаем текущий URL после отправки
                    const currentUrl = page.url();
                    console.log(`📍 Текущий URL: ${currentUrl}`);

                    // Делаем прямой fetch запрос с куками
                    console.log('🔄 Пробуем скачать через fetch с куками...');
                    const pdfResponse = await fetch(currentUrl, {
                        method: 'GET',
                        headers: {
                            'Cookie': cookieString,
                            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                            'Accept': 'application/pdf,text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
                        }
                    });

                    if (pdfResponse.ok) {
                        const pdfBuffer = Buffer.from(await pdfResponse.arrayBuffer());
                        console.log(`📦 Получено ${pdfBuffer.length} байт через fetch`);

                        // Проверяем сигнатуру PDF
                        const isPdf = pdfBuffer.length > 4 &&
                            pdfBuffer[0] === 0x25 && pdfBuffer[1] === 0x50 &&
                            pdfBuffer[2] === 0x44 && pdfBuffer[3] === 0x46;

                        if (isPdf) {
                            await savePdf(pdfBuffer, locator);
                            return;
                        } else {
                            console.log('❌ Полученные данные - не PDF');
                            console.log('Первые 50 байт:', pdfBuffer.slice(0, 50));

                            // Сохраняем для анализа
                            const debugPath = path.join(__dirname, 'test_downloads', `debug_${Date.now()}.bin`);
                            await fs.promises.writeFile(debugPath, pdfBuffer);
                            console.log(`📝 Сохранено для анализа: ${debugPath}`);
                        }
                    }

                    // Если fetch не сработал, пробуем через браузер
                    console.log('🔄 Пробуем через браузер...');

                    // Ждём появления ссылки на PDF
                    const pdfLink = await page.waitForSelector('a[href$=".pdf"], a:has-text("Download")', { timeout: 5000 }).catch(() => null);

                    if (pdfLink) {
                        try {
                            const [download] = await Promise.all([
                                page.waitForEvent('download', { timeout: 10000 }),
                                pdfLink.click()
                            ]);

                            const fileName = download.suggestedFilename() || `truecertify_${locator}_${Date.now()}.pdf`;
                            const filePath = path.join(__dirname, 'test_downloads', fileName);
                            await download.saveAs(filePath);

                            // Проверяем размер
                            const stats = await fs.promises.stat(filePath);
                            console.log(`📦 Скачано через браузер: ${stats.size} байт`);

                            if (stats.size > 10000) {
                                console.log(`✅ PDF скачан: ${fileName}`);
                                return;
                            } else {
                                console.log(`⚠️ Файл слишком маленький: ${stats.size} байт`);
                            }
                        } catch (downloadError) {
                            console.log('❌ Ошибка при скачивании через браузер:', downloadError);
                        }
                    }

                    // Если ничего не сработало, делаем скриншот
                    const screenshotPath = path.join(__dirname, 'test_downloads', `error_${Date.now()}.png`);
                    await page.screenshot({ path: screenshotPath, fullPage: true });
                    console.log(`📸 Скриншот ошибки: ${screenshotPath}`);
                }
            }
        } else {
            console.log(`❌ Капча не решена за ${maxWaitTime} секунд`);
        }

        console.log('\n⏳ Браузер закроется через 15 секунд...');
        await page.waitForTimeout(15000);

    } finally {
        await context.close();
    }
}

// Вспомогательная функция для сохранения PDF
async function savePdf(pdfBuffer: Buffer, locator: string) {
    const downloadDir = path.join(__dirname, 'test_downloads');
    await fs.promises.mkdir(downloadDir, { recursive: true });

    const fileName = `truecertify_${locator}_${Date.now()}.pdf`;
    const filePath = path.join(downloadDir, fileName);
    await fs.promises.writeFile(filePath, pdfBuffer);

    console.log(`✅ PDF сохранён: ${fileName}`);
    console.log(`📍 Путь: ${filePath}`);
    console.log(`📊 Размер: ${pdfBuffer.length} байт`);
}

testNopecha().catch(console.error);