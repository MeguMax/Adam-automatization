import asyncio
import os
import random
import requests
from io import BytesIO
import easyocr
from playwright.async_api import async_playwright
import numpy as np
from PIL import Image

class TrueCertifyDownloader:
    def __init__(self):
        """Инициализация загрузчика с EasyOCR"""
        print("🔄 Инициализация EasyOCR (первый запуск может быть долгим)...")
        # Инициализируем EasyOCR для английского языка
        # При первом запуске скачает модели (~100-200 МБ)
        self.reader = easyocr.Reader(['en'], gpu=False)
        print("✅ EasyOCR готов!")

        self.stats = {
            'attempts': 0,
            'successful_recognitions': 0
        }

    async def human_like_delay(self, min_sec=0.5, max_sec=1.5):
        """Имитация человеческой задержки"""
        delay = random.uniform(min_sec, max_sec)
        await asyncio.sleep(delay)

    def preprocess_image(self, image_bytes):
        """Предобработка изображения для EasyOCR"""
        # Открываем изображение
        img = Image.open(BytesIO(image_bytes))

        # Конвертируем в RGB если нужно
        if img.mode != 'RGB':
            img = img.convert('RGB')

        # Увеличиваем контраст
        from PIL import ImageEnhance
        enhancer = ImageEnhance.Contrast(img)
        img = enhancer.enhance(1.5)

        # Увеличиваем резкость
        enhancer = ImageEnhance.Sharpness(img)
        img = enhancer.enhance(2.0)

        # Сохраняем во временный байтовый поток
        img_bytes = BytesIO()
        img.save(img_bytes, format='PNG')
        img_bytes.seek(0)

        return img_bytes

    def recognize_captcha(self, image_bytes):
        """Распознавание текста с помощью EasyOCR"""
        self.stats['attempts'] += 1

        # Предобработка
        processed_img = self.preprocess_image(image_bytes)

        # Распознаем текст
        result = self.reader.readtext(
            np.array(Image.open(processed_img)),
            paragraph=False,
            detail=0,  # Возвращаем только текст
            allowlist='ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'  # Только буквы и цифры
        )

        if result:
            # Объединяем все найденные фрагменты
            recognized_text = ''.join(result).strip()
            # Оставляем только буквы и цифры
            recognized_text = ''.join(c for c in recognized_text if c.isalnum()).upper()

            print(f"📝 Распознанный текст: '{recognized_text}'")

            if recognized_text:
                self.stats['successful_recognitions'] += 1
                return recognized_text

        print("❌ Текст не распознан")
        return None

    async def download_file_with_captcha(self, locator, public_key, output_dir="./downloads"):
        """Основной метод для скачивания файла"""
        os.makedirs(output_dir, exist_ok=True)

        async with async_playwright() as p:
            browser = await p.chromium.launch(
                headless=False,
                args=['--disable-blink-features=AutomationControlled']
            )

            context = await browser.new_context(
                viewport={'width': 1280, 'height': 720},
                user_agent='Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
            )

            page = await context.new_page()

            # Маскируем автоматизацию
            await page.add_init_script("""
                Object.defineProperty(navigator, 'webdriver', {
                    get: () => undefined
                });
            """)

            try:
                url = f"https://eservices.truecertify.com/?loc={locator}&key={public_key}"
                print(f"🌐 Переходим на страницу: {url}")

                await page.goto(url, wait_until='networkidle')
                await self.human_like_delay(1, 2)

                # Проверяем авто-скачивание
                try:
                    async with page.expect_download(timeout=3000) as download_info:
                        pass
                    download = await download_info.value
                    await download.save_as(os.path.join(output_dir, download.suggested_filename))
                    print(f"✅ Файл автоматически скачан: {download.suggested_filename}")
                    return True
                except:
                    print("⏳ Авто-скачивания нет, проходим капчу...")

                max_attempts = 3

                for attempt in range(max_attempts):
                    print(f"\n--- Попытка {attempt + 1}/{max_attempts} ---")

                    captcha_img = await page.query_selector('.tc-image-container img')
                    if not captcha_img:
                        print("❌ Изображение капчи не найдено")
                        break

                    img_src = await captcha_img.get_attribute('src')
                    img_url = f"https://eservices.truecertify.com{img_src}" if img_src.startswith('/') else img_src

                    response = requests.get(img_url)

                    if response.status_code == 200:
                        captcha_text = self.recognize_captcha(response.content)

                        if captcha_text:
                            print(f"✏️ Вводим текст: {captcha_text}")

                            # Очищаем поле и вводим текст
                            await page.fill('#CaptchaValue', '')
                            await self.human_like_delay(0.2, 0.5)
                            await page.fill('#CaptchaValue', captcha_text)
                            await self.human_like_delay(0.5, 1)

                            submit_button = await page.query_selector('.tc-submit')

                            async with page.expect_download(timeout=15000) as download_info:
                                await submit_button.click()

                            download = await download_info.value
                            file_path = os.path.join(output_dir, download.suggested_filename)
                            await download.save_as(file_path)

                            print(f"✅ ФАЙЛ СКАЧАН: {download.suggested_filename}")

                            print(f"\n📊 Статистика:")
                            print(f"Попыток: {self.stats['attempts']}")
                            print(f"Успешно: {self.stats['successful_recognitions']}")
                            print(f"Точность: {self.stats['successful_recognitions']/self.stats['attempts']*100:.1f}%")

                            return True
                        else:
                            print("❌ Текст не распознан, пробуем обновить капчу...")

                            refresh_link = await page.query_selector('.tc-accessibility-link')
                            if refresh_link and attempt < max_attempts - 1:
                                await refresh_link.click()
                                await self.human_like_delay(2, 3)
                    else:
                        print(f"❌ Ошибка загрузки изображения: {response.status_code}")

                print("❌ Не удалось пройти капчу")
                return False

            except Exception as e:
                print(f"❌ Ошибка: {e}")
                return False
            finally:
                await page.wait_for_timeout(5000)
                await browser.close()

async def main():
    """Простой запуск"""
    downloader = TrueCertifyDownloader()

    locator = "MIP63-S2HGMQ-FF7DC1F3"
    public_key = "3A7"

    success = await downloader.download_file_with_captcha(locator, public_key)

    if success:
        print("\n✅ Операция завершена успешно!")
    else:
        print("\n❌ Операция не удалась")

if __name__ == "__main__":
    asyncio.run(main())