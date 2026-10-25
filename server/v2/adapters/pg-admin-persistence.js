/**
 * Transaction-scoped Admin Persistence Adapter for V2.
 * Enforces atomic transaction boundaries for administrative state mutations and audit events.
 */

import { MissingDatabaseDriverError } from './pg-idempotency.js';
import { assertPermission, createAdminAuditEvent } from '../core/rbac.js';

export class PgAdminPersistence {
  /**
   * @param {Object} dbClient - Production DB client or explicit test memory driver
   */
  constructor(dbClient) {
    if (!dbClient) {
      throw new MissingDatabaseDriverError('PgAdminPersistence');
    }
    this.db = dbClient;
  }

  /**
   * Executes administrative work inside a single transaction-scoped context.
   *
   * @param {Function} workFn - Async function receiving transaction-scoped context `tx`
   * @returns {Promise<any>}
   */
  async withTransaction(workFn) {
    return await this.db.withTransaction(workFn);
  }
}

/**
 * EXPLICIT TEST DOUBLE: MemoryAdminPersistence
 * Simulates transaction-scoped semantic repositories and atomic commit/rollback for testing.
 */
export class MemoryAdminPersistence {
  constructor() {
    this.featureFlags = new Map();
    this.configRulesets = new Map();
    this.killSwitches = new Map();
    this.auditLogs = [];
    this.simulateAuditFailure = false;
  }

  async withTransaction(workFn) {
    const tx = new MemoryAdminTxContext(this);
    try {
      const result = await workFn(tx);
      tx.commit();
      return result;
    } catch (err) {
      tx.rollback();
      throw err;
    }
  }

  async isEnabled(flagKey) {
    return this.featureFlags.get(flagKey) ?? false;
  }

  async getRulesetByVersion(version) {
    return this.configRulesets.get(version) || null;
  }

  async isKillSwitchActive(switchKey) {
    return this.killSwitches.get(switchKey) ?? false;
  }

  async getAuditRecords() {
    return [...this.auditLogs];
  }
}

class MemoryAdminTxContext {
  constructor(parentStorage) {
    this.parent = parentStorage;
    this.stagedFlags = new Map();
    this.stagedRulesets = new Map();
    this.stagedKillSwitches = new Map();
    this.stagedAuditLogs = [];
    this.committed = false;
    this.rolledBack = false;

    // Transaction-scoped semantic repositories
    this.featureFlags = {
      set: async (flagKey, enabled) => {
        this._assertActive();
        this.stagedFlags.set(flagKey, Boolean(enabled));
      },
      get: async (flagKey) => {
        this._assertActive();
        if (this.stagedFlags.has(flagKey)) return this.stagedFlags.get(flagKey);
        return this.parent.featureFlags.get(flagKey) ?? false;
      },
    };

    this.config = {
      saveRuleset: async (version, status, definitions) => {
        this._assertActive();
        this.stagedRulesets.set(version, { version, status, definitions });
      },
      getRulesetByVersion: async (version) => {
        this._assertActive();
        if (this.stagedRulesets.has(version)) return this.stagedRulesets.get(version);
        return this.parent.configRulesets.get(version) || null;
      },
    };

    this.killSwitch = {
      setKillSwitch: async (switchKey, active) => {
        this._assertActive();
        this.stagedKillSwitches.set(switchKey, Boolean(active));
      },
      isKillSwitchActive: async (switchKey) => {
        this._assertActive();
        if (this.stagedKillSwitches.has(switchKey)) return this.stagedKillSwitches.get(switchKey);
        return this.parent.killSwitches.get(switchKey) ?? false;
      },
    };

    this.audit = {
      logAuditEvent: async ({ adminActor, action, targetRef, reason, commandId, metadata }) => {
        this._assertActive();
        if (this.parent.simulateAuditFailure) {
          throw new Error('Simulated audit persistence failure inside transaction.');
        }
        assertPermission(adminActor.role, action);
        const auditRecord = createAdminAuditEvent({
          adminActor,
          action,
          targetRef,
          reason,
          commandId,
          metadata,
        });
        this.stagedAuditLogs.push(auditRecord);
        return auditRecord;
      },
    };
  }

  _assertActive() {
    if (this.committed) {
      throw new Error('Transaction Error: Cannot perform operations after COMMIT.');
    }
    if (this.rolledBack) {
      throw new Error('Transaction Error: Cannot perform operations after ROLLBACK.');
    }
  }

  commit() {
    this.committed = true;
    for (const [k, v] of this.stagedFlags.entries()) {
      this.parent.featureFlags.set(k, v);
    }
    for (const [k, v] of this.stagedRulesets.entries()) {
      this.parent.configRulesets.set(k, v);
    }
    for (const [k, v] of this.stagedKillSwitches.entries()) {
      this.parent.killSwitches.set(k, v);
    }
    this.parent.auditLogs.push(...this.stagedAuditLogs);
  }

  rollback() {
    this.rolledBack = true;
    this.stagedFlags.clear();
    this.stagedRulesets.clear();
    this.stagedKillSwitches.clear();
    this.stagedAuditLogs = [];
  }
}
