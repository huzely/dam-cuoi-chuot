import test from 'node:test';
import assert from 'node:assert/strict';
import { executePipeline } from '../core/pipeline.js';
import { createCommand } from '../core/command.js';
import { createDomainEvent } from '../core/event.js';
import { IdempotencyStore } from '../core/idempotency.js';

test('executePipeline runs validation, domain action, tx mutation, and commits outbox events', async () => {
  const idempotencyStore = new IdempotencyStore();
  const actor = { actorId: 'usr_festival_goer' };
  const cmd = createCommand({
    type: 'festival.enter_booth',
    actor,
    idempotencyKey: 'idem_fest_1',
    payload: { boothId: 'booth_dappie' },
  });

  const pipelineResult = await executePipeline({
    command: cmd,
    validateFn: async (command) => {
      if (!command.payload.boothId) {
        throw new Error('boothId is required');
      }
    },
    handlerFn: async ({ command, tx, outbox }) => {
      // Record DB state mutation
      await tx.recordMutation({
        table: 'festival_booth_visitors',
        action: 'INSERT',
        data: { boothId: command.payload.boothId, userId: command.actor.actorId },
      });

      // Emit domain event
      const evt = createDomainEvent({
        eventType: 'festival.booth_entered',
        aggregate: { type: 'festival_booth', id: command.payload.boothId },
        actor: { actorId: command.actor.actorId },
        payload: { entryTicket: 't_001' },
      });
      outbox.record(evt);

      return { status: 'ENTERED', ticket: 't_001' };
    },
    idempotencyStore,
  });

  assert.equal(pipelineResult.replayed, false);
  assert.equal(pipelineResult.result.status, 'ENTERED');
  assert.equal(pipelineResult.committedEvents.length, 1);

  const event = pipelineResult.committedEvents[0];
  assert.equal(event.eventType, 'festival.booth_entered');
  assert.equal(event.aggregate.id, 'booth_dappie');
  assert.equal(event.actor.actorId, 'usr_festival_goer');

  // Verify idempotency replay on second execution
  const replayResult = await executePipeline({
    command: cmd,
    handlerFn: async () => {
      throw new Error('Should not be executed during replay');
    },
    idempotencyStore,
  });

  assert.equal(replayResult.replayed, true);
  assert.equal(replayResult.result.status, 'ENTERED');
});

test('executePipeline rolls back mutations and clears outbox on error', async () => {
  const actor = { actorId: 'usr_fail' };
  const cmd = createCommand({
    type: 'festival.enter_booth',
    actor,
    payload: { boothId: 'booth_invalid' },
  });

  await assert.rejects(async () => {
    await executePipeline({
      command: cmd,
      handlerFn: async ({ tx, outbox }) => {
        await tx.recordMutation({ table: 'visitors', action: 'INSERT' });
        outbox.record(createDomainEvent({
          eventType: 'festival.booth_entered',
          aggregate: { type: 'booth', id: 'booth_invalid' },
        }));
        throw new Error('Database write constraint failed');
      },
    });
  }, /Database write constraint failed/);
});
