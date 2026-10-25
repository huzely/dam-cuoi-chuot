/**
 * Durable Postgres Feature Flag Repository Adapter.
 * Reads feature flags from the v2_feature_flags table.
 *
 * Safety Rules:
 * 1. Safe Default: Missing flag rows resolve safely to OFF (false).
 * 2. Unregistered/unknown flags are strictly rejected (UnregisteredFlagError).
 */

import { FEATURE_FLAGS } from '../core/feature-flags.js';

export class UnregisteredFlagError extends Error {
  constructor(flagKey) {
    super(`Unregistered feature flag: "${flagKey}". Only registered V2 feature flags are allowed.`);
    this.name = 'UnregisteredFlagError';
    this.code = 'UNREGISTERED_FEATURE_FLAG';
  }
}

export class PgFeatureFlagRepository {
  /**
   * @param {Object} [dbClient]
   */
  constructor(dbClient = null) {
    this.db = dbClient || new MemoryPgFeatureFlagDriver();
    this.validFlags = new Set(Object.values(FEATURE_FLAGS));
  }

  /**
   * Checks if a flag is enabled.
   * Rejects unregistered flags.
   * Resolves missing flags safely to OFF (false).
   *
   * @param {string} flagKey
   * @returns {Promise<boolean>}
   */
  async isEnabled(flagKey) {
    if (!this.validFlags.has(flagKey)) {
      throw new UnregisteredFlagError(flagKey);
    }

    const row = await this.db.getFlagRow(flagKey);
    if (!row) {
      return false; // Safe default: Missing row resolves to false
    }

    return Boolean(row.enabled);
  }

  /**
   * Asserts that a feature flag is enabled.
   */
  async assertEnabled(flagKey) {
    const enabled = await this.isEnabled(flagKey);
    if (!enabled) {
      throw new Error(`Feature flag "${flagKey}" is DISABLED.`);
    }
  }
}

class MemoryPgFeatureFlagDriver {
  constructor() {
    this.table = new Map();
  }

  async setFlag(flagKey, enabled) {
    this.table.set(flagKey, { flagKey, enabled: Boolean(enabled) });
  }

  async getFlagRow(flagKey) {
    return this.table.get(flagKey) || null;
  }
}
