import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { getWorkflowDatabase, WorkflowDatabase } from './database';

export interface MiFileCredentials {
    username: string;
    password: string;
    accountEnvironment: 'test' | 'production';
    accountLabel: string;
    productionConfirmed: boolean;
    source: 'environment' | 'admin';
}

function encryptionKey(environment: NodeJS.ProcessEnv): Buffer {
    const value = environment.MIFILE_CREDENTIALS_KEY || '';
    if (!/^[a-f0-9]{64}$/i.test(value)) {
        throw new Error('Configure MIFILE_CREDENTIALS_KEY with 64 hexadecimal characters to enable account settings.');
    }
    return Buffer.from(value, 'hex');
}

export function accountSettingsEnabled(environment: NodeJS.ProcessEnv = process.env): boolean {
    return /^[a-f0-9]{64}$/i.test(environment.MIFILE_CREDENTIALS_KEY || '');
}

export function encryptMiFileAccount(credentials: MiFileCredentials, environment: NodeJS.ProcessEnv): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', encryptionKey(environment), iv);
    cipher.setAAD(Buffer.from('legal-workflow:mifile-account:v1'));
    const encrypted = Buffer.concat([cipher.update(JSON.stringify(credentials), 'utf8'), cipher.final()]);
    return JSON.stringify({ version: 1, iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), data: encrypted.toString('base64') });
}

export function decryptMiFileAccount(value: string, environment: NodeJS.ProcessEnv): MiFileCredentials {
    try {
        const stored = JSON.parse(value);
        if (stored.version !== 1) throw new Error('Unsupported version');
        const decipher = createDecipheriv('aes-256-gcm', encryptionKey(environment), Buffer.from(stored.iv, 'base64'));
        decipher.setAAD(Buffer.from('legal-workflow:mifile-account:v1'));
        decipher.setAuthTag(Buffer.from(stored.tag, 'base64'));
        const plaintext = Buffer.concat([decipher.update(Buffer.from(stored.data, 'base64')), decipher.final()]);
        const result = JSON.parse(plaintext.toString('utf8')) as MiFileCredentials;
        if (!result.username || !result.password || !['test', 'production'].includes(result.accountEnvironment)) {
            throw new Error('Invalid credential record');
        }
        return { ...result, source: 'admin' };
    } catch {
        throw new Error('Saved MiFILE credentials could not be decrypted. Restore the original encryption key or save the account again.');
    }
}

export function getMiFileCredentials(
    environment: NodeJS.ProcessEnv = process.env,
    db?: WorkflowDatabase,
): MiFileCredentials {
    const stored = (db || (environment === process.env ? getWorkflowDatabase() : undefined))
        ?.getRuntimeSetting('mifile_account');
    if (stored) return decryptMiFileAccount(stored, environment);
    const primary = environment.MIFILE_ACCOUNT_ENVIRONMENT === 'production';
    return {
        username: environment.MIFILE_USER?.trim() || '',
        password: environment.MIFILE_PASSWORD || '',
        accountEnvironment: primary ? 'production' : 'test',
        accountLabel: environment.MIFILE_ACCOUNT_LABEL?.trim() || (primary ? 'Production account' : 'Alternate account (live MiFILE)'),
        productionConfirmed: primary && ['1', 'true', 'yes', 'on'].includes(
            (environment.MIFILE_PRODUCTION_ACCOUNT_CONFIRMED || '').toLowerCase()),
        source: 'environment',
    };
}

export function accountSettingsView(environment: NodeJS.ProcessEnv = process.env, db?: WorkflowDatabase) {
    try {
        const credentials = getMiFileCredentials(environment, db);
        return {
            username: credentials.username,
            passwordConfigured: Boolean(credentials.password),
            accountEnvironment: credentials.accountEnvironment,
            accountLabel: credentials.accountLabel,
            source: credentials.source,
            editable: accountSettingsEnabled(environment),
            error: null as string | null,
        };
    } catch (error) {
        return { username: '', passwordConfigured: false, accountEnvironment: 'test', accountLabel: '',
            source: 'admin', editable: accountSettingsEnabled(environment), error: (error as Error).message };
    }
}

export function credentialsFromSettingsInput(
    input: unknown,
    current: MiFileCredentials | null,
): MiFileCredentials {
    if (!input || typeof input !== 'object') throw new Error('Account settings are required.');
    const body = input as Record<string, unknown>;
    const username = typeof body.username === 'string' ? body.username.trim() : '';
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(username) || username.length > 254) {
        throw new Error('Enter a valid MiFILE login email.');
    }
    const suppliedPassword = typeof body.password === 'string' ? body.password : '';
    if (suppliedPassword.length > 1024) throw new Error('The password is too long.');
    const password = suppliedPassword ||
        (current?.username.toLowerCase() === username.toLowerCase() ? current.password : '');
    if (!password) throw new Error('Enter the password for this MiFILE account.');
    if (!['test', 'production'].includes(String(body.accountEnvironment))) throw new Error('Choose the account type.');
    const productionConfirmed = body.productionConfirmed === true;
    if (body.accountEnvironment === 'production' && !productionConfirmed) {
        throw new Error('Confirm the primary account before activating it.');
    }
    return {
        username, password,
        accountEnvironment: body.accountEnvironment as 'test' | 'production',
        accountLabel: body.accountEnvironment === 'production' ? 'Primary account (live MiFILE)' : 'Alternate account (live MiFILE)',
        productionConfirmed, source: 'admin',
    };
}

export function miFileCredentialIdentity(credentials: MiFileCredentials): string {
    return createHash('sha256').update(credentials.username).update('\0').update(credentials.password).digest('hex');
}
