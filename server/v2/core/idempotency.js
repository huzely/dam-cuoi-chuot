/**
 * Idempotency Contract & Memory Store Primitive for V2.
 *
 * Defines execution state lifecycle:
 * - NEW -> CLAIMED (PENDING)
 * - PENDING -> COMPLETED (cached result) or FAILED (error record)
 *
 * Unified Async Contract:
 * - claim(key, command) -> Promise<{ status: 'CLAIMED'|'COMPLETED', result?, previousError? }>
 * - complete(actorId, key, result) -> Promise<void>
 * - fail(actorId, key, error) -> Promise<void>
 */

import crypto from 'node:crypto';

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

/**
 * Computes a canonical, deterministic SHA-256 fingerprint for a command.
 * @param {string} commandType
 * @param {Object} payload
 * @returns {string} SHA-256 hex digest
 */
export function computeCanonicalFingerprint(commandType, payload) {
  const canonicalPayload = canonicalizeJson(payload || {});
  const rawString = `${commandType}:${canonicalPayload}`;
  return crypto.createHash('sha256').update(rawString).digest('hex');
}

function canonicalizeJson(obj) {
  if (obj === null || typeof obj !== 'object') {
    return JSON.stringify(obj);
  }
  if (Array.isArray(obj)) {
    return '[' + obj.map(canonicalizeJson).join(',') + ']';
  }
  const keys = Object.keys(obj).sort();
  const keyValues = keys.map(k => `${JSON.stringify(k)}:${canonicalizeJson(obj[k])}`);
  return '{' + keyValues.join(',') + '}';
}

export class IdempotencyStore {
  constructor() {
    /** @type {Map<string, { status: 'PENDING'|'COMPLETED'|'FAILED', commandType: string, requestFingerprint: string, result?: any, error?: any, createdAt: string }>} */
    this.records = new Map();
  }

  _makeKey(actorId, key) {
    return `${actorId || 'global'}::${key}`;
  }

  /**
   * Claims an idempotency key for command execution.
   */
  async claim(key, command) {
    if (!key) {
      return { status: 'CLAIMED' };
    }

    const actorId = command.actor.actorId;
    const pk = this._makeKey(actorId, key);
    const fingerprint = computeCanonicalFingerprint(command.type, command.payload);
    const existing = this.records.get(pk);

    if (!existing) {
      this.records.set(pk, {
        status: 'PENDING',
        commandType: command.type,
        requestFingerprint: fingerprint,
        createdAt: new Date().toISOString(),
      });
      return { status: 'CLAIMED' };
    }

    if (existing.commandType !== command.type || existing.requestFingerprint !== fingerprint) {
      throw new IdempotencyMismatchError(
        `Idempotency key "${key}" for actor "${actorId}" was previously used for a different command or payload.`
      );
    }

    if (existing.status === 'PENDING') {
      throw new ConcurrentExecutionError(
        `Execution for idempotency key "${key}" (actor "${actorId}") is currently in progress.`
      );
    }

    if (existing.status === 'COMPLETED') {
      return { status: 'COMPLETED', result: existing.result };
    }

    if (existing.status === 'FAILED') {
      this.records.set(pk, {
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
  async complete(actorId, key, result) {
    if (!key) return;
    const pk = this._makeKey(actorId, key);
    const existing = this.records.get(pk);
    if (existing) {
      existing.status = 'COMPLETED';
      existing.result = result;
      existing.completedAt = new Date().toISOString();
    }
  }

  /**
   * Marks execution as failed.
   */
  async fail(actorId, key, error) {
    if (!key) return;
    const pk = this._makeKey(actorId, key);
    const existing = this.records.get(pk);
    if (existing) {
      existing.status = 'FAILED';
      existing.error = error instanceof Error ? { message: error.message, code: error.code } : error;
      existing.failedAt = new Date().toISOString();
    }
  }

  get(actorId, key) {
    return this.records.get(this._makeKey(actorId, key)) || null;
  }
}
