import assert from 'node:assert/strict';
import test from 'node:test';
import { getMiFileRuntimeConfig } from './mifileRuntimeConfig';

test('MiFILE runtime defaults to safe test and unsubmitted-only mode', () => {
    const config = getMiFileRuntimeConfig({
        MIFILE_USER: 'test@example.com',
        MIFILE_PASSWORD: 'secret',
    });

    assert.equal(config.accountEnvironment, 'test');
    assert.equal(config.preparationMode, 'unsubmitted_only');
    assert.equal(config.ready, true);
});

test('production MiFILE preparation requires explicit account confirmation', () => {
    const unconfirmed = getMiFileRuntimeConfig({
        MIFILE_ACCOUNT_ENVIRONMENT: 'production',
        MIFILE_USER: 'filing@example.com',
        MIFILE_PASSWORD: 'secret',
    });
    assert.equal(unconfirmed.ready, false);
    assert.ok(unconfirmed.issues.some(issue => issue.includes('explicitly confirmed')));

    const confirmed = getMiFileRuntimeConfig({
        MIFILE_ACCOUNT_ENVIRONMENT: 'production',
        MIFILE_PRODUCTION_ACCOUNT_CONFIRMED: 'true',
        MIFILE_USER: 'filing@example.com',
        MIFILE_PASSWORD: 'secret',
        MIFILE_EXPECTED_ACCOUNT_EMAIL: 'filing@example.com',
    });
    assert.equal(confirmed.ready, true);
    assert.equal(confirmed.accountLabel, 'Production account');
});

test('MiFILE runtime rejects mismatched expected account credentials', () => {
    const config = getMiFileRuntimeConfig({
        MIFILE_USER: 'wrong@example.com',
        MIFILE_PASSWORD: 'secret',
        MIFILE_EXPECTED_ACCOUNT_EMAIL: 'expected@example.com',
    });

    assert.equal(config.ready, false);
    assert.ok(config.issues.some(issue => issue.includes('expected account')));
});
