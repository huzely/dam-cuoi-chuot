/**
 * Command Execution Pipeline Primitive for V2.
 *
 * Flow:
 * Command -> Validation -> Async Idempotency Check -> Domain Action -> Unit of Work -> Commit -> Async Outbox Publication
 */

import { TransactionContext, UnitOfWork } from './transaction.js';
import { OutboxRecorder, OutboxPublisher } from './outbox.js';

export async function executePipeline({
  command,
  validateFn = null,
  handlerFn,
  idempotencyStore = null,
  featureFlags = null,
  publisherFn = null,
  txContextOverride = null,
}) {
  if (!command || !command.type) {
    throw new Error('Pipeline requires a valid command.');
  }

  // 1. Validation step
  if (validateFn) {
    await validateFn(command, { featureFlags });
  }

  // 2. Idempotency claim step
  const idempotencyKey = command.idempotencyKey;
  const actorId = command.actor?.actorId;

  if (idempotencyStore && idempotencyKey) {
    const claimResult = await idempotencyStore.claim(idempotencyKey, command);
    if (claimResult.status === 'COMPLETED') {
      return {
        replayed: true,
        result: claimResult.result,
      };
    }
  }

  // 3. Domain action & Unit of Work
  const tx = txContextOverride || new TransactionContext();
  const outbox = new OutboxRecorder();
  const uow = new UnitOfWork(tx, outbox);

  try {
    const result = await uow.execute(async (activeTx, activeOutbox) => {
      return await handlerFn({
        command,
        tx: activeTx,
        outbox: activeOutbox,
      });
    });

    // 4. Post-commit Outbox Event Publication
    const publisher = new OutboxPublisher(publisherFn || (async () => {}));
    const publishResult = await publisher.publishCommitted(outbox.getCommittedOutboxRecords());

    // 5. Record idempotency completion
    if (idempotencyStore && idempotencyKey) {
      await idempotencyStore.complete(actorId, idempotencyKey, result);
    }

    return {
      replayed: false,
      result,
      committedOutboxRecords: outbox.getCommittedOutboxRecords(),
      publishedEvents: publishResult.publishedEvents,
      publicationErrors: publishResult.publicationErrors,
    };
  } catch (err) {
    // Record idempotency failure
    if (idempotencyStore && idempotencyKey) {
      await idempotencyStore.fail(actorId, idempotencyKey, err);
    }
    throw err;
  }
}
