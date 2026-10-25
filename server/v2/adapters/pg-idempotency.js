/**
 * Durable Postgres Idempotency Store Adapter.
 *
 * Scope: (actor_id, key)
 * Fingerprint: Canonical SHA-256 digest of command identity + payload
 */

import crypto from 'node:crypto';
import {
  IdempotencyMismatchError,
  ConcurrentExecutionError,
} from '../core/idempotency.js';

/**
 * Computes a canonical, deterministic SHA-256 fingerprint for a command.
 *
 * @param {string} commandType
 * @param {Object} payload
 * @returns {string} SHA-256 hex digest
 */
export function computeCanonicalFingerprint(commandType, payload) {
  const canonicalPayload = canonicalizeJson(payload || {});
  const rawString = `${commandType}:${canonicalPayload}`;
  return crypto.createHash('sha256').update(rawString).digest('hex');
}

/**
 * Recursively canonicalizes JSON keys to produce a deterministic string representation.
 */
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

export class PgIdempotencyStore {
  /**
   * @param {Object} [dbClient] - Postgres/Supabase DB client interface or mock driver
   */
  constructor(dbClient = null) {
    this.db = dbClient || new MemoryPgDriver();
  }

  /**
   * Claims an idempotency key scoped to actor_id.
   *
   * @param {string} key - Idempotency key
   * @param {Object} command - Command instance containing actor, type, and payload
   * @returns {Promise<{ status: 'CLAIMED' | 'COMPLETED', result?: any, previousError?: any }>}
   */
  async claim(key, command) {
    if (!key) {
      return { status: 'CLAIMED' };
    }

    const actorId = command.actor.actorId;
    const fingerprint = computeCanonicalFingerprint(command.type, command.payload);

    const existing = await this.db.getIdempotencyRecord(actorId, key);

    if (!existing) {
      await this.db.insertIdempotencyRecord({
        actorId,
        key,
        commandType: command.type,
        requestFingerprint: fingerprint,
        status: 'PENDING',
        createdAt: new Date().toISOString(),
      });
      return { status: 'CLAIMED' };
    }

    // Different request fingerprint for same actor + key -> IdempotencyMismatchError
    if (existing.commandType !== command.type || existing.requestFingerprint !== fingerprint) {
      throw new IdempotencyMismatchError(
        `Idempotency key "${key}" for actor "${actorId}" was previously used for a different command or request signature.`
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
      await this.db.updateIdempotencyRecord(actorId, key, {
        status: 'PENDING',
        error: null,
        updatedAt: new Date().toISOString(),
      });
      return { status: 'CLAIMED', previousError: existing.error };
    }

    throw new Error(`Unknown idempotency state "${existing.status}" for key "${key}".`);
  }

  async complete(actorId, key, result) {
    if (!key) return;
    await this.db.updateIdempotencyRecord(actorId, key, {
      status: 'COMPLETED',
      result,
      completedAt: new Date().toISOString(),
    });
  }

  async fail(actorId, key, error) {
    if (!key) return;
    await this.db.updateIdempotencyRecord(actorId, key, {
      status: 'FAILED',
      error: error instanceof Error ? { message: error.message, code: error.code } : error,
      failedAt: new Date().toISOString(),
    });
  }
}

/**
 * In-memory DB driver simulating PostgreSQL (actor_id, key) composite primary key behavior.
 */
class MemoryPgDriver {
  constructor() {
    this.table = new Map();
  }

  _makeKey(actorId, key) {
    return `${actorId}::${key}`;
  }

  async getIdempotencyRecord(actorId, key) {
    return this.table.get(this._makeKey(actorId, key)) || null;
  }

  async insertIdempotencyRecord(record) {
    const pk = this._makeKey(record.actorId, record.key);
    if (this.table.has(pk)) {
      throw new Error(`DB Unique Violation: (actor_id, key) = (${record.actorId}, ${record.key}) already exists.`);
    }
    this.table.set(pk, { ...record });
  }

  async updateIdempotencyRecord(actorId, key, updates) {
    const pk = this._makeKey(actorId, key);
    const existing = this.table.get(pk);
    if (existing) {
      this.table.set(pk, { ...existing, ...updates, updatedAt: new Date().toISOString() });
    }
  }
}
