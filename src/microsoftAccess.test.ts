import assert from 'node:assert/strict';
import test from 'node:test';
import { checkMicrosoftAccess } from './microsoftAccess';

const env = {
    TENANT_ID: 'test-tenant', CLIENT_ID: 'test-client', CLIENT_SECRET: 'private-secret',
    USER_EMAIL: 'fixture@example.com',
    ONEDRIVE_ROOT_SHARE_URL: 'https://fixture-my.sharepoint.com/:f:/g/abc?e=private-folder',
};
const token = (roles: string[]) => 'header.' + Buffer.from(JSON.stringify({ roles })).toString('base64url') + '.signature';
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
const successfulResponse = (url: URL) => {
    if (url.pathname.endsWith('/mailFolders/inbox')) return json({ id: 'private-inbox' });
    if (url.pathname.includes('/shares/')) return json({ id: 'private-folder', folder: {}, parentReference: { driveId: 'private-drive' } });
    if (url.pathname.endsWith('/children')) return json({ value: [{ id: 'private-file' }] });
    throw new Error('Unexpected Graph resource');
};

test('missing application credentials do not make network requests', async () => {
    const result = await checkMicrosoftAccess({ env: {}, getToken: async () => { throw new Error('Unexpected sign-in'); },
        request: async () => { throw new Error('Unexpected request'); } });
    assert.equal(result.authentication.status, 'not_configured');
    assert.equal(result.inbox.status, 'not_configured');
    assert.equal(result.oneDrive.status, 'not_configured');
    assert.equal(result.fileWritePermission, 'unknown');
});

test('checks inbox metadata and folder listing using GET only without redeeming the link', async () => {
    const urls: URL[] = [];
    const bearer = token(['Files.ReadWrite.All', 'Mail.ReadWrite', 'Mail.Send']);
    const result = await checkMicrosoftAccess({ env, getToken: async () => bearer, request: async (input, init) => {
        const url = new URL(String(input));
        urls.push(url);
        assert.equal(url.origin, 'https://graph.microsoft.com');
        assert.equal(init?.method, 'GET');
        assert.equal(init?.redirect, 'error');
        assert.ok(init?.signal);
        assert.equal(new Headers(init?.headers).get('Authorization'), 'Bearer ' + bearer);
        assert.equal(new Headers(init?.headers).has('Prefer'), false);
        assert.equal(init?.body, undefined);
        return successfulResponse(url);
    } });
    assert.equal(urls.length, 3);
    assert.ok(urls.some(url => url.pathname === '/v1.0/shares/u!' + Buffer.from(env.ONEDRIVE_ROOT_SHARE_URL).toString('base64url') + '/driveItem'));
    assert.ok(urls.every(url => ['id', 'id,folder,parentReference'].includes(url.searchParams.get('$select')!)));
    assert.equal(urls.find(url => url.pathname.endsWith('/children'))?.searchParams.get('$top'), '1');
    assert.equal(result.authentication.status, 'ok');
    assert.equal(result.inbox.status, 'ok');
    assert.equal(result.oneDrive.status, 'ok');
    assert.equal(result.oneDrive.host, 'fixture-my.sharepoint.com');
    assert.equal(result.fileWritePermission, 'granted_not_tested');
    assert.equal(result.mailSendPermission, 'granted_not_tested');
    assert.equal(result.readOnly, true);
    const serialized = JSON.stringify(result);
    for (const secret of [bearer, env.CLIENT_SECRET, env.USER_EMAIL, env.ONEDRIVE_ROOT_SHARE_URL,
        'private-inbox', 'private-folder', 'private-drive', 'private-file']) assert.equal(serialized.includes(secret), false);
});

test('mailbox denial does not hide successful OneDrive access or expose response bodies', async () => {
    const result = await checkMicrosoftAccess({ env, getToken: async () => token(['Files.ReadWrite.All']),
        request: async input => String(input).includes('/mailFolders/')
            ? new Response('private Graph diagnostic', { status: 403 }) : successfulResponse(new URL(String(input))) });
    assert.deepEqual(result.inbox, { status: 'failed', reason: 'access_denied', http: 403 });
    assert.equal(result.oneDrive.status, 'ok');
    assert.equal(result.mailSendPermission, 'not_granted');
    assert.equal(JSON.stringify(result).includes('private Graph diagnostic'), false);
});

test('read-only roles and selected-resource grants are not mistaken for broad write rights', async () => {
    for (const [roles, permission] of [
        [['Files.Read.All', 'Mail.Read'], 'not_granted'],
        [['Sites.Selected', 'Mail.Send'], 'unknown'],
        [['Files.SelectedOperations.Selected'], 'unknown'],
        [['Sites.ReadWrite.All'], 'granted_not_tested'],
    ] as const) {
        const result = await checkMicrosoftAccess({ env, getToken: async () => token([...roles]),
            request: async input => successfulResponse(new URL(String(input))) });
        assert.equal(result.fileWritePermission, permission);
    }
});

test('opaque tokens can establish resource access but not permission claims', async () => {
    const result = await checkMicrosoftAccess({ env, getToken: async () => 'opaque-token',
        request: async input => successfulResponse(new URL(String(input))) });
    assert.equal(result.inbox.status, 'ok');
    assert.equal(result.oneDrive.status, 'ok');
    assert.equal(result.fileWritePermission, 'unknown');
    assert.equal(result.mailSendPermission, 'unknown');
});

test('does not request unconfigured resources', async () => {
    const result = await checkMicrosoftAccess({ env: { ...env, USER_EMAIL: '', ONEDRIVE_ROOT_SHARE_URL: '' },
        getToken: async () => 'opaque-token', request: async () => { throw new Error('Unexpected request'); } });
    assert.equal(result.authentication.status, 'ok');
    assert.equal(result.inbox.status, 'not_configured');
    assert.equal(result.oneDrive.status, 'not_configured');
});

test('invalid folder URLs never redirect the bearer token outside Microsoft Graph', async () => {
    for (const share of ['http://fixture.sharepoint.com/folder', 'https://sharepoint.com.attacker.example/folder',
        'https://user:password@fixture.sharepoint.com/folder', 'file:///private', 'not a url']) {
        const result = await checkMicrosoftAccess({ env: { ...env, ONEDRIVE_ROOT_SHARE_URL: share },
            getToken: async () => 'opaque-token', request: async input => {
                assert.ok(String(input).includes('/mailFolders/inbox?'));
                return json({ id: 'private-inbox' });
            } });
        assert.equal(result.oneDrive.reason, 'invalid_configuration');
        assert.equal(result.inbox.status, 'ok');
    }
});

test('file links are rejected without listing their parent folder', async () => {
    let folderRequests = 0;
    const result = await checkMicrosoftAccess({ env, getToken: async () => 'opaque-token', request: async input => {
        if (String(input).includes('/shares/')) { folderRequests++; return json({ id: 'a-file', file: {}, parentReference: { driveId: 'private-drive' } }); }
        assert.ok(String(input).includes('/mailFolders/'));
        return json({ id: 'inbox' });
    } });
    assert.equal(folderRequests, 1);
    assert.equal(result.oneDrive.reason, 'not_a_folder');
});

test('invalid JSON or listing shape yields a bounded diagnostic without raw content', async () => {
    for (const response of [() => new Response('secret: not JSON'), () => json({ unexpected: 'secret' })]) {
        const result = await checkMicrosoftAccess({ env, getToken: async () => 'opaque-token', request: async input =>
            String(input).includes('/children?') ? response() : successfulResponse(new URL(String(input))) });
        assert.equal(result.oneDrive.reason, 'invalid_response');
        assert.equal(result.inbox.status, 'ok');
        assert.equal(JSON.stringify(result).includes('secret'), false);
    }
});

test('token rejection is sanitized and does not start resource requests', async () => {
    const result = await checkMicrosoftAccess({ env, getToken: async () => { throw new Error('private token response'); },
        request: async () => { throw new Error('Unexpected request'); } });
    assert.equal(result.authentication.status, 'failed');
    assert.equal(result.inbox.reason, 'sign_in_failed');
    assert.equal(result.oneDrive.reason, 'sign_in_failed');
    assert.equal(JSON.stringify(result).includes('private token response'), false);
});

test('deadline bounds a token provider that ignores cancellation', async () => {
    const result = await checkMicrosoftAccess({ env, timeoutMs: 20, getToken: () => new Promise(() => {}) });
    assert.equal(result.authentication.reason, 'timeout');
    assert.equal(result.inbox.reason, 'timeout');
    assert.equal(result.oneDrive.reason, 'timeout');
});

test('deadline bounds stalled response-body reading and network requests independently', async () => {
    const result = await checkMicrosoftAccess({ env, timeoutMs: 20, getToken: async () => 'opaque-token',
        request: async input => {
            if (String(input).includes('/mailFolders/')) return new Response(new ReadableStream({ start() {} }));
            return new Promise<Response>(() => {});
        } });
    assert.equal(result.authentication.status, 'ok');
    assert.equal(result.inbox.reason, 'timeout');
    assert.equal(result.oneDrive.reason, 'timeout');
});

test('deadline also bounds cancellation of an error body', async () => {
    const result = await checkMicrosoftAccess({ env, timeoutMs: 20, getToken: async () => 'opaque-token', request: async () =>
        new Response(new ReadableStream({ cancel: () => new Promise<void>(() => {}) }), { status: 403 }) });
    assert.equal(result.inbox.reason, 'timeout');
    assert.equal(result.oneDrive.reason, 'timeout');
});
