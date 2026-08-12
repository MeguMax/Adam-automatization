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
