/**
 * Idempotency Contract & Memory Store Primitive for V2.
 *
 * Defines execution state lifecycle:
 * - NEW -> CLAIMED (PENDING)
 * - PENDING -> COMPLETED (cached result) or FAILED (error record)
 *
 * Enforces semantics for:
 * 1. Completed replay (returns cached result without re-executing side effects)
 * 2. Pending concurrent duplicate detection
 * 3. Payload mismatch detection
 * 4. Explicit failure and retry handling
 */

export class IdempotencyMismatchError extends Error {
  constructor(message) {
    super(message);
    this.name = 'IdempotencyMismatchError';
    this.code = 'IDEMPOTENCY_KEY_MISMATCH';
  }
}

export class ConcurrentExecutionError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ConcurrentExecutionError';
    this.code = 'CONCURRENT_EXECUTION_IN_PROGRESS';
  }
}

export class IdempotencyStore {
  constructor() {
    /** @type {Map<string, { status: 'PENDING'|'COMPLETED'|'FAILED', commandType: string, payloadHash: string, result?: any, error?: any, createdAt: string }>} */
    this.records = new Map();
  }

  /**
   * Helper to compute a simple signature hash for command payload verification.
   */
  _computeHash(commandType, payload) {
    return `${commandType}:${JSON.stringify(payload || {})}`;
  }

  /**
   * Claims an idempotency key for command execution.
   *
   * @param {string} key - Idempotency key
   * @param {Object} command - Command instance containing type and payload
   * @returns {{ status: 'CLAIMED' | 'COMPLETED', result?: any, previousError?: any }}
   */
  claim(key, command) {
    if (!key) {
      return { status: 'CLAIMED' }; // No key provided, execution proceeds without idempotency caching
    }

    const payloadHash = this._computeHash(command.type, command.payload);
    const existing = this.records.get(key);

    if (!existing) {
      // NEW KEY -> Claim for pending execution
      this.records.set(key, {
        status: 'PENDING',
        commandType: command.type,
        payloadHash,
        createdAt: new Date().toISOString(),
      });
      return { status: 'CLAIMED' };
    }

    // Verify key is not being reused for a different command type or payload
    if (existing.commandType !== command.type || existing.payloadHash !== payloadHash) {
      throw new IdempotencyMismatchError(`Idempotency key "${key}" was previously used for a different command or payload.`);
    }

    if (existing.status === 'PENDING') {
      throw new ConcurrentExecutionError(`Execution for idempotency key "${key}" is currently in progress.`);
    }

    if (existing.status === 'COMPLETED') {
      return { status: 'COMPLETED', result: existing.result };
    }

    if (existing.status === 'FAILED') {
      // Allow retry after failure: update status back to PENDING for the new retry attempt
      this.records.set(key, {
        ...existing,
        status: 'PENDING',
        error: undefined,
        updatedAt: new Date().toISOString(),
      });
      return { status: 'CLAIMED', previousError: existing.error };
    }

    throw new Error(`Unknown idempotency state "${existing.status}" for key "${key}".`);
  }

  /**
   * Marks execution as completed and caches the result.
   */
  complete(key, result) {
    if (!key) return;
    const existing = this.records.get(key);
    if (existing) {
      existing.status = 'COMPLETED';
      existing.result = result;
      existing.completedAt = new Date().toISOString();
    }
  }

  /**
   * Marks execution as failed.
   */
  fail(key, error) {
    if (!key) return;
    const existing = this.records.get(key);
    if (existing) {
      existing.status = 'FAILED';
      existing.error = error instanceof Error ? { message: error.message, code: error.code } : error;
      existing.failedAt = new Date().toISOString();
    }
  }

  /**
   * Retrieves the record for inspection.
   */
  get(key) {
    return this.records.get(key) || null;
  }
}
