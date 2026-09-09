import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { createAdminAuth } from './adminAuth';

async function fixture(run: (base: string, advance: (ms: number) => void) => Promise<void>, production = false) {
    const saved = { ADMIN_USERNAME: process.env.ADMIN_USERNAME, ADMIN_PASSWORD: process.env.ADMIN_PASSWORD, NODE_ENV: process.env.NODE_ENV };
    Object.assign(process.env, { ADMIN_USERNAME: 'admin', ADMIN_PASSWORD: 'test-password', NODE_ENV: production ? 'production' : 'test' });
    let clock = Date.now();
    const auth = createAdminAuth(() => clock);
    const server = http.createServer(async (req, res) => {
        if (await auth(req, res, new URL(req.url!, 'http://localhost').pathname)) res.end('protected');
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    try { await run(base, ms => { clock += ms; }); }
    finally {
        await new Promise<void>(resolve => { server.close(() => resolve()); server.closeIdleConnections(); });
        for (const [key, value] of Object.entries(saved)) {
            if (value === undefined) delete process.env[key]; else process.env[key] = value;
        }
    }
}

async function login(base: string, password = 'test-password', origin = base) {
    return fetch(`${base}/auth/login`, { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: 'admin', password }) });
}

test('unauthenticated browsers get a login page, not a native Basic Auth challenge', async () => fixture(async base => {
    const root = await fetch(base, { redirect: 'manual' });
    assert.equal(root.status, 303);
    assert.equal(root.headers.get('location'), '/login');
    assert.equal(root.headers.get('www-authenticate'), null);
    const page = await fetch(`${base}/login`);
    assert.equal(page.status, 200);
    assert.ok((await page.text()).includes('autocomplete="current-password"'));
    assert.ok(page.headers.get('content-security-policy')?.includes("frame-ancestors 'none'"));
    for (const path of ['/api/summary', '/assets/pdfjs/pdf.mjs']) {
        const response = await fetch(base + path);
        assert.equal(response.status, 401);
        assert.equal(response.headers.get('www-authenticate'), null);
    }
    const invalid = await login(base, 'incorrect');
    assert.equal(invalid.status, 401);
    assert.equal(invalid.headers.get('set-cookie'), null);
    assert.equal(invalid.headers.get('www-authenticate'), null);
}));

test('sessions support cookie login, rotation, logout and expiry without leaking the password', async () => fixture(async (base, advance) => {
    const signedIn = await login(base);
    assert.equal(signedIn.status, 200);
    const setCookie = signedIn.headers.get('set-cookie')!;
    assert.ok(setCookie.includes('HttpOnly'));
    assert.ok(setCookie.includes('SameSite=Strict'));
    assert.ok(!setCookie.includes('test-password'));
    const first = setCookie.split(';')[0];
    assert.equal((await fetch(base + '/api/summary', { headers: { Cookie: first } })).status, 200);
    assert.equal((await fetch(base + '/api/summary', { headers: { Cookie: first + 'tampered' } })).status, 401);
    const rotated = await fetch(base + '/auth/login', { method: 'POST', headers: { Cookie: first, Origin: base, 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: 'admin', password: 'test-password' }) });
    const second = rotated.headers.get('set-cookie')!.split(';')[0];
    assert.notEqual(first, second);
    assert.equal((await fetch(base + '/api/summary', { headers: { Cookie: first } })).status, 401);
    const logout = await fetch(base + '/auth/logout', { method: 'POST', headers: { Cookie: second, Origin: base } });
    assert.equal(logout.status, 200);
    assert.ok(logout.headers.get('set-cookie')?.includes('Max-Age=0'));
    assert.equal((await fetch(base + '/api/summary', { headers: { Cookie: second } })).status, 401);
    const third = (await login(base)).headers.get('set-cookie')!.split(';')[0];
    advance(12 * 60 * 60 * 1000 + 1);
    assert.equal((await fetch(base + '/api/summary', { headers: { Cookie: third } })).status, 401);
}));

test('cookie sessions reject cross-origin writes; account changes revoke sessions; API Basic Auth remains supported', async () => fixture(async base => {
    const token = (await login(base)).headers.get('set-cookie')!.split(';')[0];
    for (const origin of ['', 'https://untrusted.example']) {
        const write = await fetch(base + '/api/change', { method: 'POST', headers: { Cookie: token, Origin: origin } });
        assert.equal(write.status, 403);
        assert.equal((await login(base, 'test-password', origin)).status, 403);
    }
    assert.equal((await fetch(base + '/api/change', { method: 'POST', headers: { Cookie: token, Origin: base } })).status, 200);
    process.env.ADMIN_PASSWORD = 'changed-password';
    assert.equal((await fetch(base + '/api/summary', { headers: { Cookie: token } })).status, 401);
    const basic = Buffer.from('admin:changed-password').toString('base64');
    assert.equal((await fetch(base + '/api/summary', { headers: { Authorization: 'Basic ' + basic } })).status, 200);
}));

test('production uses Secure cookies and limits login attempts', async () => fixture(async (base, advance) => {
    const origin = base.replace('http:', 'https:');
    assert.equal((await login(base)).status, 403);
    const success = await login(base, 'test-password', origin);
    assert.ok(success.headers.get('set-cookie')?.includes('; Secure'));
    for (let i = 0; i < 59; i++) assert.equal((await login(base, 'incorrect', origin)).status, 401);
    const limited = await login(base, 'incorrect', origin);
    assert.equal(limited.status, 429);
    assert.equal(limited.headers.get('retry-after'), '60');
    advance(60_001);
    assert.equal((await login(base, 'test-password', origin)).status, 200);
}, true));
