import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { WorkflowDatabase } from './database';
import {
    accountSettingsView, credentialsFromSettingsInput, decryptMiFileAccount,
    encryptMiFileAccount, getMiFileCredentials, MiFileCredentials, miFileCredentialIdentity,
    initializeMiFileAccountEncryption,
} from './mifileAccountSettings';

const environment = { MIFILE_CREDENTIALS_KEY: 'ab'.repeat(32), MIFILE_USER: 'old@example.com', MIFILE_PASSWORD: 'old-secret' };
const account: MiFileCredentials = {
    username: 'primary@example.com', password: 'new-secret-123', accountEnvironment: 'production',
    productionConfirmed: true, accountLabel: 'Primary account', source: 'admin',
};

test('account encryption uses fresh nonces and authenticates the ciphertext', () => {
    const first = encryptMiFileAccount(account, environment);
    assert.notEqual(first, encryptMiFileAccount(account, environment));
    assert.ok(!first.includes(account.password));
    assert.ok(!first.includes(account.username));
    assert.deepEqual(decryptMiFileAccount(first, environment), account);
    const corrupted = JSON.parse(first);
    corrupted.data = Buffer.from('bad-data').toString('base64');
    assert.throws(() => decryptMiFileAccount(JSON.stringify(corrupted), environment), /could not be decrypted/);
    assert.throws(() => decryptMiFileAccount(first, { MIFILE_CREDENTIALS_KEY: 'cd'.repeat(32) }), /could not be decrypted/);
    assert.throws(() => encryptMiFileAccount(account, {}), /MIFILE_CREDENTIALS_KEY/);
});

test('saved accounts survive restart, override environment credentials, and never expose secrets in settings', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mifile-settings-'));
    const filename = path.join(directory, 'test.sqlite');
    let db = new WorkflowDatabase(filename);
    try {
        db.saveMiFileAccountSetting(encryptMiFileAccount(account, environment));
        db.close();
        db = new WorkflowDatabase(filename);
        assert.deepEqual(getMiFileCredentials(environment, db), account);
        const view = accountSettingsView(environment, db);
        assert.equal(view.username, account.username);
        assert.equal(view.passwordConfigured, true);
        assert.equal('password' in view, false);
        assert.ok(!JSON.stringify(view).includes(account.password));
        const wrongKey = { ...environment, MIFILE_CREDENTIALS_KEY: 'ef'.repeat(32) };
        assert.throws(() => getMiFileCredentials(wrongKey, db), /could not be decrypted/);
        assert.ok(accountSettingsView(wrongKey, db).error);
        assert.ok(!fs.readFileSync(filename).includes(Buffer.from(account.password)));
    } finally { db.close(); fs.rmSync(directory, { recursive: true, force: true }); }
});

test('blank password keeps the existing secret only for the same account', () => {
    const input = { username: account.username, password: '', accountEnvironment: 'production', productionConfirmed: true };
    assert.equal(credentialsFromSettingsInput(input, account).password, account.password);
    assert.throws(() => credentialsFromSettingsInput({ ...input, username: 'different@example.com' }, account), /Enter the password/);
    assert.throws(() => credentialsFromSettingsInput({ ...input, productionConfirmed: false }, account), /Confirm/);
    assert.throws(() => credentialsFromSettingsInput({ ...input, username: 'bad email' }, account), /valid MiFILE/);
    assert.notEqual(miFileCredentialIdentity(account), miFileCredentialIdentity({ ...account, password: 'rotated' }));
});

test('production key bootstrapping persists one private key and decrypts the account after restart', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mifile-key-'));
    const filename = path.join(directory, 'workflow.sqlite');
    const keyPath = path.join(directory, '.secrets', 'mifile-credentials.key');
    let db = new WorkflowDatabase(filename);
    try {
        const first: NodeJS.ProcessEnv = {};
        const result = initializeMiFileAccountEncryption(db, first);
        assert.deepEqual(result, { source: 'persistent_file', created: true });
        assert.match(first.MIFILE_CREDENTIALS_KEY!, /^[a-f0-9]{64}$/);
        assert.ok(!JSON.stringify(result).includes(first.MIFILE_CREDENTIALS_KEY!));
        assert.equal(fs.readFileSync(keyPath, 'utf8'), first.MIFILE_CREDENTIALS_KEY);
        if (process.platform !== 'win32') {
            assert.equal(fs.statSync(keyPath).mode & 0o777, 0o600);
            assert.equal(fs.statSync(path.dirname(keyPath)).mode & 0o777, 0o700);
        }
        db.saveMiFileAccountSetting(encryptMiFileAccount(account, first));
        db.close();
        db = new WorkflowDatabase(filename);
        const restarted: NodeJS.ProcessEnv = {};
        assert.deepEqual(initializeMiFileAccountEncryption(db, restarted), {
            source: 'persistent_file', created: false,
        });
        assert.equal(restarted.MIFILE_CREDENTIALS_KEY, first.MIFILE_CREDENTIALS_KEY);
        assert.deepEqual(getMiFileCredentials(restarted, db), account);
        assert.equal(accountSettingsView(restarted, db).editable, true);
        assert.ok(!fs.readFileSync(filename).includes(Buffer.from(account.password)));
        assert.ok(!fs.readFileSync(filename).includes(Buffer.from(first.MIFILE_CREDENTIALS_KEY!)));
    } finally {
        db.close();
        assert.equal(path.dirname(directory), os.tmpdir());
        fs.rmSync(directory, { recursive: true, force: true });
    }
});

test('an explicit key takes precedence and an invalid explicit key is never replaced', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mifile-key-'));
    const db = new WorkflowDatabase(path.join(directory, 'workflow.sqlite'));
    try {
        const configured = { ...environment };
        assert.deepEqual(initializeMiFileAccountEncryption(db, configured), {
            source: 'environment', created: false,
        });
        assert.equal(configured.MIFILE_CREDENTIALS_KEY, environment.MIFILE_CREDENTIALS_KEY);
        assert.equal(fs.existsSync(path.join(directory, '.secrets')), false);
        const invalid = { MIFILE_CREDENTIALS_KEY: 'not-a-key' };
        assert.throws(() => initializeMiFileAccountEncryption(db, invalid), /64 hexadecimal/);
        assert.equal(invalid.MIFILE_CREDENTIALS_KEY, 'not-a-key');
        assert.equal(fs.existsSync(path.join(directory, '.secrets')), false);
    } finally {
        db.close();
        assert.equal(path.dirname(directory), os.tmpdir());
        fs.rmSync(directory, { recursive: true, force: true });
    }
});

test('a lost key never generates a replacement for an already saved account', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mifile-key-'));
    const db = new WorkflowDatabase(path.join(directory, 'workflow.sqlite'));
    try {
        db.saveMiFileAccountSetting(encryptMiFileAccount(account, environment));
        const missing: NodeJS.ProcessEnv = { MIFILE_USER: 'fallback@example.com', MIFILE_PASSWORD: 'fallback' };
        assert.throws(() => initializeMiFileAccountEncryption(db, missing), /Restore MIFILE_CREDENTIALS_KEY/);
        assert.equal(missing.MIFILE_CREDENTIALS_KEY, undefined);
        assert.equal(fs.existsSync(path.join(directory, '.secrets', 'mifile-credentials.key')), false);
        assert.throws(() => getMiFileCredentials(missing, db), /could not be decrypted/);
    } finally {
        db.close();
        assert.equal(path.dirname(directory), os.tmpdir());
        fs.rmSync(directory, { recursive: true, force: true });
    }
});

test('a corrupt or wrong persistent key is preserved and fails closed', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mifile-key-'));
    const db = new WorkflowDatabase(path.join(directory, 'workflow.sqlite'));
    const keyPath = path.join(directory, '.secrets', 'mifile-credentials.key');
    try {
        const first: NodeJS.ProcessEnv = {};
        initializeMiFileAccountEncryption(db, first);
        db.saveMiFileAccountSetting(encryptMiFileAccount(account, first));
        for (const corrupted of ['truncated', 'z'.repeat(64), 'cd'.repeat(32)]) {
            fs.writeFileSync(keyPath, corrupted);
            const restarted: NodeJS.ProcessEnv = {};
            assert.throws(() => initializeMiFileAccountEncryption(db, restarted));
            assert.equal(restarted.MIFILE_CREDENTIALS_KEY, undefined);
            assert.equal(fs.readFileSync(keyPath, 'utf8'), corrupted);
        }
    } finally {
        db.close();
        assert.equal(path.dirname(directory), os.tmpdir());
        fs.rmSync(directory, { recursive: true, force: true });
    }
});

test('a persistent key path must be a regular file', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mifile-key-'));
    const db = new WorkflowDatabase(path.join(directory, 'workflow.sqlite'));
    const keyPath = path.join(directory, '.secrets', 'mifile-credentials.key');
    try {
        fs.mkdirSync(keyPath, { recursive: true });
        assert.throws(() => initializeMiFileAccountEncryption(db, {}), /key file is invalid/);
        assert.ok(fs.statSync(keyPath).isDirectory());
    } finally {
        db.close();
        assert.equal(path.dirname(directory), os.tmpdir());
        fs.rmSync(directory, { recursive: true, force: true });
    }
});
