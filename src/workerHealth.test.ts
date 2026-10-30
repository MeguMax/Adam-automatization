import { test } from 'node:test';
import assert from 'node:assert/strict';
import { WorkerHealth } from './workerHealth';

test('worker health distinguishes unmonitored, disabled, idle, stalled and recovered work', () => {
    let time = 1_000_000;
    const health = new WorkerHealth(() => time);
    assert.equal(health.snapshot().workers[0].state, 'not_started');
    health.disable('extraction'); health.start('inbox', 10_000);
    assert.equal(health.snapshot().workers[1].state, 'disabled');
    health.work('inbox', 'processing_email', 90_000);
    time += 90_001;
    assert.equal(health.snapshot().workers[0].state, 'stalled');
    assert.equal(health.snapshot().attention, true);
    health.work('inbox', 'fetching_email');
    assert.equal(health.snapshot().workers[0].state, 'working');
    health.finish('inbox');
    assert.equal(health.snapshot().workers[0].state, 'idle');
    assert.ok(health.snapshot().workers[0].lastSuccessfulCycleAt);
    time += 60_001;
    assert.equal(health.snapshot().workers[0].state, 'stalled');
    health.finish('inbox', false);
    assert.equal(health.snapshot().workers[0].state, 'error');
    health.stop('inbox'); health.work('inbox', 'checking');
    assert.equal(health.snapshot().workers[0].state, 'stopped');
});

test('health deadlines follow real checkpoints, not reads, and expose no arbitrary stage content', () => {
    let time = 1_000_000;
    const health = new WorkerHealth(() => time);
    health.start('mifile', 5000);
    health.work('mifile', 'password=private' as any, 20_000);
    assert.equal(health.snapshot().workers[2].phase, 'Checking for work');
    time += 10_000; health.snapshot(); time += 10_001;
    assert.equal(health.snapshot().workers[2].state, 'stalled');
    assert.ok(!JSON.stringify(health.snapshot()).includes('private'));
    health.work('mifile', 'checking_bundle');
    assert.equal(health.snapshot().workers[2].state, 'working');
    assert.equal(health.snapshot().workers[2].lastSuccessfulCycleAt, null);
});
