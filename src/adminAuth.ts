import http from 'node:http';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

const COOKIE = 'legal_admin_session';
const SESSION_MS = 12 * 60 * 60 * 1000;

export function hasAdminCredentials(): boolean {
    return Boolean(process.env.ADMIN_USERNAME && process.env.ADMIN_PASSWORD);
}

function equal(left: string, right: string): boolean {
    const digest = (value: string) => createHash('sha256').update(value).digest();
    return timingSafeEqual(digest(left), digest(right));
}

function credentialsMatch(username: unknown, password: unknown): boolean {
    if (!hasAdminCredentials() || typeof username !== 'string' || typeof password !== 'string') return false;
    const userMatches = equal(username, process.env.ADMIN_USERNAME!);
    const passwordMatches = equal(password, process.env.ADMIN_PASSWORD!);
    return userMatches && passwordMatches;
}

function credentialVersion(): string {
    return createHash('sha256').update(JSON.stringify([process.env.ADMIN_USERNAME, process.env.ADMIN_PASSWORD])).digest('hex');
}

function sessionToken(req: http.IncomingMessage): string {
    return (req.headers.cookie || '').split(';').map(value => value.trim())
        .find(value => value.startsWith(`${COOKIE}=`))?.slice(COOKIE.length + 1) || '';
}

function sameOrigin(req: http.IncomingMessage): boolean {
    if (req.headers['sec-fetch-site'] === 'cross-site') return false;
    try {
        const origin = new URL(req.headers.origin || '');
        return origin.host === req.headers.host &&
            (process.env.NODE_ENV === 'production' ? origin.protocol === 'https:' : ['http:', 'https:'].includes(origin.protocol));
    } catch { return false; }
}

function json(res: http.ServerResponse, status: number, body: object): void {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(body));
}

function redirect(res: http.ServerResponse, path: string): void {
    res.writeHead(303, { Location: path, 'Cache-Control': 'no-store' });
    res.end();
}

function cookie(value: string, maxAge: number): string {
    return `${COOKIE}=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}` +
        (process.env.NODE_ENV === 'production' ? '; Secure' : '');
}

function loginPage(nonce: string): string {
    return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><title>Sign in | Legal Workflow</title>
<style nonce="${nonce}">
*{box-sizing:border-box}body{margin:0;background:#f5f7f8;color:#202b33;font:15px/1.5 system-ui,sans-serif;letter-spacing:0}
main{width:min(100% - 40px,400px);margin:80px auto}header{border-bottom:3px solid #26715c;padding-bottom:22px;margin-bottom:28px}
h1{font-size:26px;margin:0 0 4px}header p{margin:0;color:#57616d}h2{font-size:20px;margin:0 0 22px}
label{display:block;font-weight:600;margin:18px 0 6px}input,button{font:inherit;width:100%;min-height:46px;border-radius:6px}
input{border:1px solid #a7b2bd;padding:10px 12px;background:white;color:#202b33}input:focus{outline:2px solid #26715c;outline-offset:2px}
button{margin-top:20px;background:#246b57;color:white;border:0;font-weight:600;cursor:pointer}button:disabled{opacity:.65;cursor:wait}
#error{color:#a32d34;min-height:24px;margin:16px 0 0;overflow-wrap:anywhere}@media(max-width:480px){main{margin-top:40px}}
</style></head><body><main><header><h1>Legal Workflow</h1><p>Devlin Law PLLC</p></header>
<h2>Sign in</h2><form id="loginForm" action="/auth/login" method="post">
<label for="username">Username</label><input id="username" name="username" autocomplete="username" maxlength="254" required autofocus>
<label for="password">Password</label><input id="password" name="password" type="password" autocomplete="current-password" maxlength="1024" required>
<button id="signIn" type="submit">Sign in</button><p id="error" role="alert" aria-live="polite"></p>
</form><noscript>JavaScript is required to sign in.</noscript></main>
<script nonce="${nonce}">
document.getElementById('loginForm').addEventListener('submit', async function(event) {
    event.preventDefault();
    const button = document.getElementById('signIn');
    const error = document.getElementById('error');
    button.disabled = true; button.textContent = 'Signing in...'; error.textContent = '';
    try {
        const response = await fetch('/auth/login', { method: 'POST', headers: {'Content-Type':'application/json'},
            body: JSON.stringify({username:document.getElementById('username').value, password:document.getElementById('password').value}) });
        const result = await response.json();
        if (!response.ok) throw new Error(result.error || 'Sign-in failed. Please try again.');
        window.location.replace('/');
    } catch (failure) { error.textContent = failure.message || 'Connection interrupted. Please try again.'; }
    finally { button.disabled = false; button.textContent = 'Sign in'; }
});
</script></body></html>`;
}

async function readLogin(req: http.IncomingMessage): Promise<unknown> {
    return new Promise((resolve, reject) => {
        const chunks: Buffer[] = [];
        let size = 0;
        req.on('data', chunk => {
            size += chunk.length;
            if (size <= 8192) chunks.push(Buffer.from(chunk));
        });
        req.on('error', reject);
        req.on('end', () => {
            if (size > 8192) return reject(new Error('Request too large'));
            try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
            catch { reject(new Error('Invalid JSON')); }
        });
    });
}

export function createAdminAuth(now: () => number = Date.now) {
    const sessions = new Map<string, { expires: number; version: string }>();
    let attempts = 0;
    let windowStart = now();

    // Return true only when the protected route may continue.
    return async (req: http.IncomingMessage, res: http.ServerResponse, pathname: string): Promise<boolean> => {
        const time = now();
        for (const [token, session] of sessions) if (session.expires <= time) sessions.delete(token);
        const token = sessionToken(req);
        const session = sessions.get(token);
        const validSession = session?.version === credentialVersion();
        let validBasic = false;
        const basic = req.headers.authorization;
        if (basic?.startsWith('Basic ')) {
            const decoded = Buffer.from(basic.slice(6), 'base64').toString('utf8');
            const separator = decoded.indexOf(':');
            validBasic = separator >= 0 && credentialsMatch(decoded.slice(0, separator), decoded.slice(separator + 1));
        }

        if (req.method === 'GET' && pathname === '/login') {
            const nonce = randomBytes(18).toString('base64');
            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store',
                'X-Frame-Options': 'DENY', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer',
                'Content-Security-Policy': `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; connect-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'` });
            res.end(loginPage(nonce));
            return false;
        }
        if (req.method === 'POST' && pathname === '/auth/login') {
            if (!sameOrigin(req) || !req.headers['content-type']?.startsWith('application/json')) {
                json(res, 403, { error: 'Sign in from the admin login page.' });
                return false;
            }
            if (time - windowStart >= 60_000) { windowStart = time; attempts = 0; }
            if (++attempts > 60) {
                res.setHeader('Retry-After', '60');
                json(res, 429, { error: 'Too many sign-in attempts. Please wait one minute.' });
                return false;
            }
            let input: any;
            try { input = await readLogin(req); }
            catch { json(res, 400, { error: 'Invalid sign-in request.' }); return false; }
            if (!credentialsMatch(input?.username, input?.password)) {
                json(res, 401, { error: 'Incorrect username or password.' });
                return false;
            }
            if (token) sessions.delete(token);
            if (sessions.size >= 1000) sessions.delete(sessions.keys().next().value!);
            const newToken = randomBytes(32).toString('hex');
            sessions.set(newToken, { expires: time + SESSION_MS, version: credentialVersion() });
            res.setHeader('Set-Cookie', cookie(newToken, SESSION_MS / 1000));
            json(res, 200, { ok: true });
            return false;
        }
        if (req.method === 'POST' && pathname === '/auth/logout') {
            if (!sameOrigin(req)) { json(res, 403, { error: 'Same-origin request required.' }); return false; }
            sessions.delete(token);
            res.setHeader('Set-Cookie', cookie('', 0));
            json(res, 200, { ok: true });
            return false;
        }
        const devAccess = !hasAdminCredentials() && process.env.NODE_ENV !== 'production';
        if (!validSession && !validBasic && !devAccess) {
            if (req.method === 'GET' && !pathname.startsWith('/api/') && !pathname.startsWith('/assets/')) redirect(res, '/login');
            else json(res, 401, { error: 'Please sign in again.' });
            return false;
        }
        if (validSession && !['GET', 'HEAD', 'OPTIONS'].includes(req.method || '') && !sameOrigin(req)) {
            json(res, 403, { error: 'Same-origin request required.' });
            return false;
        }
        return true;
    };
}
