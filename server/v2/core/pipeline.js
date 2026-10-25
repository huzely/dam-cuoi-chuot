/**
 * Command Execution Pipeline Primitive for V2.
 *
 * Flow:
 * Command -> Validation -> Idempotency Check -> Domain Action -> Unit of Work (DB Tx + Outbox Event) -> Commit
 */

import { TransactionContext, UnitOfWork } from './transaction.js';
import { OutboxRecorder } from './outbox.js';

export async function executePipeline({
  command,
  validateFn = null,
  handlerFn,
  idempotencyStore = null,
  featureFlags = null,
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

  // 3. Domain action & Unit of Work (DB Transaction + Outbox Event)
  const tx = new TransactionContext();
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

    // 4. Record idempotency completion
    if (idempotencyStore && idempotencyKey) {
      idempotencyStore.complete(idempotencyKey, result);
    }

    return {
      replayed: false,
      result,
      committedEvents: outbox.getCommittedEvents(),
    };
  } catch (err) {
    // Record idempotency failure
    if (idempotencyStore && idempotencyKey) {
      idempotencyStore.fail(idempotencyKey, err);
    }
    throw err;
  }
}
