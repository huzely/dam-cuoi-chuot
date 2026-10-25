import test from 'node:test';
import assert from 'node:assert/strict';
import { executePipeline } from '../core/pipeline.js';
import { createCommand } from '../core/command.js';
import { createDomainEvent } from '../core/event.js';
import { TransactionContext } from '../core/transaction.js';

test('Transactional Outbox: 1. handler/state mutation failure before commit -> state & outbox both discarded', async () => {
  const actor = { actorId: 'usr_fail' };
  const cmd = createCommand({
    type: 'festival.enter_booth',
    actor,
    payload: { boothId: 'booth_invalid' },
  });

  const tx = new TransactionContext();

  await assert.rejects(async () => {
    await executePipeline({
      command: cmd,
      txContextOverride: tx,
      handlerFn: async ({ tx: activeTx, outbox }) => {
        await activeTx.recordMutation({ table: 'visitors', action: 'INSERT' });
        outbox.record(createDomainEvent({
          eventType: 'festival.booth_entered',
          aggregate: { type: 'booth', id: 'booth_invalid' },
        }));
        throw new Error('Handler state mutation validation failed');
      },
    });
  }, /Handler state mutation validation failed/);

  // Assert both state mutations and staged outbox events were discarded/rolled back
  assert.equal(tx.committed, false);
  assert.equal(tx.rolledBack, true);
  assert.equal(tx.mutations.length, 0);
  assert.equal(tx.stagedOutboxEvents.length, 0);
});

test('Transactional Outbox: 2. outbox persistence failure before commit -> transaction does not commit', async () => {
  const actor = { actorId: 'usr_outbox_fail' };
  const cmd = createCommand({
    type: 'festival.enter_booth',
    actor,
    payload: { boothId: 'booth_1' },
  });

  const tx = new TransactionContext();
  tx.simulateOutboxPersistFailure = true; // Simulate outbox table write error inside transaction

  await assert.rejects(async () => {
    await executePipeline({
      command: cmd,
      txContextOverride: tx,
      handlerFn: async ({ tx: activeTx, outbox }) => {
        await activeTx.recordMutation({ table: 'visitors', action: 'INSERT' });
        outbox.record(createDomainEvent({
          eventType: 'festival.booth_entered',
          aggregate: { type: 'booth', id: 'booth_1' },
        }));
        return { status: 'OK' };
      },
    });
  }, /Transactional outbox persistence failed before commit/);

  // Assert transaction failed to commit and was rolled back
  assert.equal(tx.committed, false);
  assert.equal(tx.rolledBack, true);
  assert.equal(tx.mutations.length, 0);
});

test('Transactional Outbox: 3. successful commit -> state and persisted outbox both become committed together', async () => {
  const actor = { actorId: 'usr_success' };
  const cmd = createCommand({
    type: 'festival.enter_booth',
    actor,
    payload: { boothId: 'booth_ok' },
  });

  const tx = new TransactionContext();

  const result = await executePipeline({
    command: cmd,
    txContextOverride: tx,
    handlerFn: async ({ tx: activeTx, outbox }) => {
      await activeTx.recordMutation({ table: 'visitors', action: 'INSERT', data: { boothId: 'booth_ok' } });
      outbox.record(createDomainEvent({
        eventType: 'festival.booth_entered',
        aggregate: { type: 'booth', id: 'booth_ok' },
        actor: { actorId: 'usr_success' },
      }));
      return { status: 'ENTERED' };
    },
  });

  // Assert transaction committed atomically
  assert.equal(tx.committed, true);
  assert.equal(tx.mutations.length, 1);
  assert.equal(tx.stagedOutboxEvents.length, 1);
  assert.equal(result.committedOutboxRecords.length, 1);
  assert.equal(result.committedOutboxRecords[0].status, 'PUBLISHED'); // Auto-published by default publisher
});

test('Transactional Outbox: 4. publication failure AFTER commit does not roll back committed state/outbox', async () => {
  const actor = { actorId: 'usr_pub_fail' };
  const cmd = createCommand({
    type: 'festival.enter_booth',
    actor,
    payload: { boothId: 'booth_pub_fail' },
  });

  const tx = new TransactionContext();

  const pipelineResult = await executePipeline({
    command: cmd,
    txContextOverride: tx,
    publisherFn: async () => {
      throw new Error('Event bus / RabbitMQ down during post-commit publication');
    },
    handlerFn: async ({ tx: activeTx, outbox }) => {
      await activeTx.recordMutation({ table: 'visitors', action: 'INSERT' });
      outbox.record(createDomainEvent({
        eventType: 'festival.booth_entered',
        aggregate: { type: 'booth', id: 'booth_pub_fail' },
      }));
      return { status: 'ENTERED' };
    },
  });

  // CRITICAL INVARIANT: DB Transaction & outbox remain committed in storage!
  assert.equal(tx.committed, true);
  assert.equal(tx.mutations.length, 1);
  assert.equal(tx.stagedOutboxEvents.length, 1);

  // Outbox record status is PUBLICATION_FAILED_RETRYABLE
  assert.equal(pipelineResult.committedOutboxRecords.length, 1);
  assert.equal(pipelineResult.committedOutboxRecords[0].status, 'PUBLICATION_FAILED_RETRYABLE');
  assert.equal(pipelineResult.publicationErrors.length, 1);
  assert.equal(pipelineResult.publicationErrors[0].error.message, 'Event bus / RabbitMQ down during post-commit publication');
});
