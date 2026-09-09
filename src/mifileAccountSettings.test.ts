import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { WorkflowDatabase } from './database';
import {
    accountSettingsView, credentialsFromSettingsInput, decryptMiFileAccount,
    encryptMiFileAccount, getMiFileCredentials, MiFileCredentials, miFileCredentialIdentity,
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
