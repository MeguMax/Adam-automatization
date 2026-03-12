import { Page } from 'playwright';

export async function solveRecaptcha(page: Page): Promise<boolean> {
    try {
        console.log('🔍 Пытаемся решить reCAPTCHA через имитацию кликов...');

        // Ждем появления iframe с reCAPTCHA
        await page.waitForSelector('iframe[src*="recaptcha"]', { timeout: 10000 });

        // Находим все iframe
        const frames = page.frames();
        const recaptchaFrame = frames.find(frame =>
            frame.url().includes('recaptcha')
        );

        if (!recaptchaFrame) {
            console.log('❌ Iframe reCAPTCHA не найден');
            return false;
        }

        // Пробуем разные селекторы для чекбокса
        const selectors = [
            '.recaptcha-checkbox-border',
            '#recaptcha-anchor',
            '.recaptcha-checkbox',
            '[role="checkbox"]'
        ];

        for (const selector of selectors) {
            const checkbox = await recaptchaFrame.$(selector);

            if (checkbox) {
                console.log(`✅ Найден чекбокс (${selector}), кликаем...`);

                // Имитируем человеческое поведение
                await checkbox.hover();
                await page.waitForTimeout(Math.random() * 500 + 500); // 500-1000ms

                // Получаем координаты для клика
                const box = await checkbox.boundingBox();
                if (box) {
                    // Кликаем в случайную точку внутри чекбокса
                    await page.mouse.click(
                        box.x + box.width * (0.3 + Math.random() * 0.4),
                        box.y + box.height * (0.3 + Math.random() * 0.4)
                    );
                } else {
                    await checkbox.click();
                }

                await page.waitForTimeout(3000);

                // Проверяем, прошла ли капча
                const checked = await recaptchaFrame.$('.recaptcha-checkbox-checked, [aria-checked="true"]');

                if (checked) {
                    console.log('🎉 reCAPTCHA успешно пройдена!');

                    // Ждем появления кнопки Continue/Submit
                    await page.waitForTimeout(1000);
                    return true;
                }
            }
        }

        // Если не сработало, пробуем альтернативный метод - ищем кнопку с аудио
        console.log('🔄 Пробуем альтернативный метод...');

        // В некоторых reCAPTCHA есть кнопка "Получить аудио"
        const audioButton = await recaptchaFrame.$('#recaptcha-audio-button, .rc-button-audio');
        if (audioButton) {
            console.log('🔊 Найдена кнопка аудио, пока не поддерживается');
        }

        return false;

    } catch (error) {
        console.error('❌ Ошибка при решении reCAPTCHA:', error);
        return false;
    }
}

// Функция для проверки наличия reCAPTCHA
export async function hasRecaptcha(page: Page): Promise<boolean> {
    const hasFrame = await page.$('iframe[src*="recaptcha"]') !== null;
    const hasDiv = await page.$('.g-recaptcha') !== null;
    return hasFrame || hasDiv;
}

// Функция для ожидания решения (пользователь решает вручную)
export async function waitForManualRecaptcha(page: Page, timeout: number = 60000): Promise<boolean> {
    console.log('👆 Пожалуйста, решите капчу вручную в браузере...');

    const startTime = Date.now();

    while (Date.now() - startTime < timeout) {
        // Проверяем, решена ли капча
        const frames = page.frames();
        const recaptchaFrame = frames.find(f => f.url().includes('recaptcha'));

        if (recaptchaFrame) {
            const checked = await recaptchaFrame.$('.recaptcha-checkbox-checked, [aria-checked="true"]');
            if (checked) {
                console.log('✅ Капча решена вручную!');
                return true;
            }
        }

        await page.waitForTimeout(1000);
    }

    console.log('❌ Таймаут ожидания ручного решения');
    return false;
}