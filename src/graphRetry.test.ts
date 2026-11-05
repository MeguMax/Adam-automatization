import assert from 'node:assert/strict';
import test from 'node:test';
import { isRetryableGraphError, withGraphRetry } from './graphRetry';

test('retries malformed Graph JSON responses even when the response status is 200', async () => {
    let calls = 0;
    const result = await withGraphRetry(
        async () => {
            calls += 1;
            if (calls < 3) {
                const error = new SyntaxError(
                    "Expected ',' or ']' after array element in JSON",
                ) as SyntaxError & { statusCode: number };
                error.statusCode = 200;
                throw error;
            }
            return 'ok';
        },
        { maxAttempts: 5, baseDelayMs: 0, maxDelayMs: 0 },
    );

    assert.equal(result, 'ok');
    assert.equal(calls, 3);
});

test('recognizes transient Graph transport and throttling failures', () => {
    assert.equal(isRetryableGraphError({ statusCode: 429, message: 'Throttled' }), true);
    assert.equal(isRetryableGraphError({ code: 'ECONNRESET' }), true);
    assert.equal(
        isRetryableGraphError({ statusCode: 200, body: 'Unexpected end of JSON input' }),
        true,
    );
    assert.equal(isRetryableGraphError({ statusCode: 400, message: 'Invalid request' }), false);
});

test('does not retry permanent Graph request errors', async () => {
    let calls = 0;
    await assert.rejects(
        withGraphRetry(
            async () => {
                calls += 1;
                throw Object.assign(
                    new Error('There is an unterminated string literal in the search query'),
                    { statusCode: 400 },
                );
            },
            { maxAttempts: 5, baseDelayMs: 0, maxDelayMs: 0 },
        ),
        /unterminated string literal/,
    );
    assert.equal(calls, 1);
});

test('aborts a stalled read and retries with a fresh signal', async () => {
    const signals: AbortSignal[] = [];
    const retries: string[] = [];
    const result = await withGraphRetry(signal => {
        signals.push(signal);
        if (signals.length === 1) return new Promise<string>(() => {});
        assert.equal(signal.aborted, false);
        return Promise.resolve('recovered');
    }, {maxAttempts: 2, attemptTimeoutMs: 10, baseDelayMs: 0,
        onRetry: retry => retries.push(retry.reason)});
    assert.equal(result, 'recovered');
    assert.equal(signals.length, 2);
    assert.equal(signals[0].aborted, true);
    assert.equal(signals[1].aborted, false);
    assert.match(retries[0], /read timed out/);
});

test('a completely stalled read exhausts its bounded attempts without blocking the next operation', async () => {
    const signals: AbortSignal[] = [];
    await assert.rejects(withGraphRetry(signal => {
        signals.push(signal);
        return new Promise<never>(() => {});
    }, {maxAttempts: 2, attemptTimeoutMs: 10, baseDelayMs: 0}), /read timed out/);
    assert.equal(signals.length, 2);
    assert.ok(signals.every(signal => signal.aborted));
    assert.equal(await withGraphRetry(async () => 'next attachment'), 'next attachment');
});

test('late failure from an expired attempt cannot override a successful retry', async () => {
    let calls = 0;
    let failExpiredRead: (error: Error) => void = () => {};
    const result = await withGraphRetry(async signal => {
        calls++;
        if (calls === 1) return new Promise<string>((_resolve, reject) => {failExpiredRead = reject;});
        assert.equal(signal.aborted, false);
        return 'ok';
    }, {maxAttempts: 2, attemptTimeoutMs: 10, baseDelayMs: 0});
    failExpiredRead(new Error('old request failed late'));
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(result, 'ok');
    assert.equal(calls, 2);
});

test('the read deadline is cleared after success and does not abort completed requests', async () => {
    let captured: AbortSignal | undefined;
    assert.equal(await withGraphRetry(async signal => {
        captured = signal;
        return 'ok';
    }, {attemptTimeoutMs: 10}), 'ok');
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(captured?.aborted, false);
});
