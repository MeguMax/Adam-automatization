import 'dotenv/config';

export const TENANT_ID = process.env.TENANT_ID ?? '';
export const CLIENT_ID = process.env.CLIENT_ID ?? '';
export const CLIENT_SECRET = process.env.CLIENT_SECRET ?? '';
export const USER_EMAIL = process.env.USER_EMAIL ?? '';

if (!TENANT_ID || !CLIENT_ID || !CLIENT_SECRET || !USER_EMAIL) {
    console.warn('⚠️ Some environment variables are missing. Check .env file.');
}
