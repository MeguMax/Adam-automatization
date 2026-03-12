import fetch from 'node-fetch';
import * as fs from 'fs/promises';
import * as path from 'path';

export class TwoCaptchaClient {
    private apiKey: string;
    private debugDir: string;
    private pollingInterval = 2000; // 2 секунды
    private maxAttempts = 30; // 60 секунд максимум

    constructor(apiKey: string, debugDir: string = './temp/captcha_debug') {
        this.apiKey = apiKey;
        this.debugDir = debugDir;
    }

    /**
     * Решение капчи через 2Captcha API v2
     */
    async solveImage(imageBuffer: Buffer): Promise<string | null> {
        try {
            // Сохраняем для отладки
            const timestamp = Date.now();
            await fs.mkdir(this.debugDir, { recursive: true });
            const imagePath = path.join(this.debugDir, `2captcha_${timestamp}.png`);
            await fs.writeFile(imagePath, imageBuffer);

            console.log('🔄 Отправляем капчу в 2Captcha...');

            // Конвертируем в base64
            const base64Image = imageBuffer.toString('base64');

            // 1. Создаём задачу
            const createResponse = await fetch('https://api.2captcha.com/createTask', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    clientKey: this.apiKey,
                    task: {
                        type: 'ImageToTextTask',
                        body: base64Image,
                        phrase: false,
                        case: true,        // учитываем регистр
                        numeric: 0,         // 0 - любые символы
                        math: false,
                        minLength: 4,
                        maxLength: 6
                    }
                })
            });

            const createResult = await createResponse.json() as any;

            if (createResult.errorId) {
                throw new Error(`Ошибка создания задачи: ${createResult.errorDescription}`);
            }

            const taskId = createResult.taskId;
            console.log(`📋 Задача создана, ID: ${taskId}`);

            // 2. Ожидаем результат
            for (let attempt = 0; attempt < this.maxAttempts; attempt++) {
                await new Promise(resolve => setTimeout(resolve, this.pollingInterval));

                const resultResponse = await fetch('https://api.2captcha.com/getTaskResult', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        clientKey: this.apiKey,
                        taskId: taskId
                    })
                });

                const result = await resultResponse.json() as any;

                if (result.status === 'ready') {
                    console.log(`✅ Капча решена: "${result.solution.text}"`);
                    return result.solution.text;
                } else if (result.status === 'processing') {
                    console.log(`⏳ Ожидаем решение... (${attempt + 1}/${this.maxAttempts})`);
                } else {
                    throw new Error(`Неожиданный статус: ${result.status}`);
                }
            }

            throw new Error('Таймаут ожидания решения капчи');

        } catch (error) {
            console.error('❌ Ошибка 2Captcha:', error);
            return null;
        }
    }

    /**
     * Получение баланса
     */
    async getBalance(): Promise<number> {
        try {
            const response = await fetch('https://api.2captcha.com/getBalance', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    clientKey: this.apiKey
                })
            });

            const result = await response.json() as any;
            const balance = result.balance || 0;
            console.log(`💰 Баланс: $${balance.toFixed(4)}`);
            return balance;
        } catch (error) {
            console.error('❌ Ошибка получения баланса:', error);
            return 0;
        }
    }
}