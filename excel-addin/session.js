(function(root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    else root.DevlinExcelSession = api;
})(typeof window === 'object' ? window : globalThis, function() {
    'use strict';
    const KEY = 'devlin.excel.session.v1';
    const MAX_MS = 12 * 60 * 60 * 1000;
    function create(storage, now = Date.now) {
        let current = null;
        let persistent = Boolean(storage);
        function valid(session) {
            return session && typeof session.token === 'string' && /^[a-f0-9]{64}$/.test(session.token) &&
                Number.isFinite(session.expiresAt) && session.expiresAt > now() && session.expiresAt <= now() + MAX_MS + 1000;
        }
        function clear() {
            current = null;
            try { storage?.removeItem(KEY); } catch { /* Some Office hosts disable browser storage. */ }
        }
        return {
            read() {
                if (persistent) {
                    let value;
                    try { value = storage.getItem(KEY); } catch { persistent = false; }
                    if (persistent) {
                        try { current = value ? JSON.parse(value) : null; }
                        catch { clear(); return null; }
                    }
                }
                if (!valid(current)) { clear(); return null; }
                return { token: current.token, expiresAt: current.expiresAt };
            },
            write(token, expiresIn) {
                const session = { token, expiresAt: now() + expiresIn * 1000 };
                if (!Number.isFinite(expiresIn) || expiresIn <= 0 || expiresIn * 1000 > MAX_MS || !valid(session)) {
                    clear(); throw new Error('The PDF service returned an invalid connection. Connect again.');
                }
                current = session;
                if (persistent) {
                    try { storage.setItem(KEY, JSON.stringify(session)); } catch { persistent = false; }
                }
                return { ...session };
            },
            clear,
        };
    }
    return { KEY, create };
});
