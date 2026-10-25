/**
 * Command Execution Pipeline Primitive for V2.
 *
 * Flow:
 * Command -> Validation -> Idempotency Check -> Domain Action -> Unit of Work (DB Tx containing Mutations + Outbox Persist) -> Commit -> Async Outbox Publication
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
  if (idempotencyStore && idempotencyKey) {
    const claimResult = idempotencyStore.claim(idempotencyKey, command);
    if (claimResult.status === 'COMPLETED') {
      return {
        replayed: true,
        result: claimResult.result,
      };
    }
  }

  // 3. Domain action & Unit of Work (Atomic DB Transaction containing State Mutations + Outbox Persistence)
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

    // At this point, tx.committed === true and outbox records are committed in DB storage.

    // 4. Post-commit Outbox Event Publication
    const publisher = new OutboxPublisher(publisherFn || (async () => {}));
    const publishResult = await publisher.publishCommitted(outbox.getCommittedOutboxRecords());

    // 5. Record idempotency completion
    if (idempotencyStore && idempotencyKey) {
      idempotencyStore.complete(idempotencyKey, result);
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
      idempotencyStore.fail(idempotencyKey, err);
    }
    throw err;
  }
}
