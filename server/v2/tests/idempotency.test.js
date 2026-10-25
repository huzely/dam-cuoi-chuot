import test from 'node:test';
import assert from 'node:assert/strict';
import {
  IdempotencyStore,
  IdempotencyMismatchError,
  ConcurrentExecutionError,
} from '../core/idempotency.js';
import { createCommand } from '../core/command.js';

test('IdempotencyStore: completed retry returns cached result without re-executing', () => {
  const store = new IdempotencyStore();
  const actor = { actorId: 'usr_1' };
  const cmd = createCommand({
    type: 'employment.accept_job',
    actor,
    idempotencyKey: 'idem_key_100',
    payload: { jobId: 'job_1' },
  });

  // 1. First claim
  const claim1 = store.claim('idem_key_100', cmd);
  assert.equal(claim1.status, 'CLAIMED');

  // 2. Execution succeeds and completes
  store.complete('idem_key_100', { success: true, contractId: 'c_999' });

  // 3. Retry with same key & command returns cached result
  const claim2 = store.claim('idem_key_100', cmd);
  assert.equal(claim2.status, 'COMPLETED');
  assert.deepEqual(claim2.result, { success: true, contractId: 'c_999' });
});

test('IdempotencyStore: concurrent pending duplicate detection throws ConcurrentExecutionError', () => {
  const store = new IdempotencyStore();
  const actor = { actorId: 'usr_1' };
  const cmd = createCommand({
    type: 'employment.accept_job',
    actor,
    idempotencyKey: 'idem_key_200',
    payload: { jobId: 'job_2' },
  });

  // Claim once (status becomes PENDING)
  store.claim('idem_key_200', cmd);

  // Second claim while still PENDING throws ConcurrentExecutionError
  assert.throws(() => {
    store.claim('idem_key_200', cmd);
  }, ConcurrentExecutionError);
});

test('IdempotencyStore: same key reused for different command/payload throws IdempotencyMismatchError', () => {
  const store = new IdempotencyStore();
  const actor = { actorId: 'usr_1' };
  const cmdA = createCommand({
    type: 'employment.accept_job',
    actor,
    idempotencyKey: 'idem_key_300',
    payload: { jobId: 'job_A' },
  });

  const cmdB = createCommand({
    type: 'employment.accept_job',
    actor,
    idempotencyKey: 'idem_key_300',
    payload: { jobId: 'job_B' }, // Different payload!
  });

  store.claim('idem_key_300', cmdA);
  store.complete('idem_key_300', { result: 'A' });

  assert.throws(() => {
    store.claim('idem_key_300', cmdB);
  }, IdempotencyMismatchError);
});

test('IdempotencyStore: failed execution records failure and allows retry', () => {
  const store = new IdempotencyStore();
  const actor = { actorId: 'usr_1' };
  const cmd = createCommand({
    type: 'employment.accept_job',
    actor,
    idempotencyKey: 'idem_key_400',
    payload: { jobId: 'job_4' },
  });

  store.claim('idem_key_400', cmd);
  store.fail('idem_key_400', new Error('Network timeout during job acceptance'));

  // Record inspect
  const rec = store.get('idem_key_400');
  assert.equal(rec.status, 'FAILED');
  assert.equal(rec.error.message, 'Network timeout during job acceptance');

  // Retry after failure claims key again
  const retryClaim = store.claim('idem_key_400', cmd);
  assert.equal(retryClaim.status, 'CLAIMED');
  assert.equal(retryClaim.previousError.message, 'Network timeout during job acceptance');
});
