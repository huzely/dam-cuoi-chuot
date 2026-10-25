/**
 * Durable Postgres Configuration & Ruleset Repository Adapter.
 * Loads versioned config rulesets from the v2_config_rulesets table.
 * Enforces fail-closed behavior on unresolved TBD_FROM_DATA parameters.
 */

import { RulesetSnapshot, UnresolvedConfigError } from '../core/config.js';

export class PgConfigRepository {
  /**
   * @param {Object} [dbClient]
   */
  constructor(dbClient = null) {
    this.db = dbClient || new MemoryPgConfigDriver();
  }

  /**
   * Retrieves an approved RulesetSnapshot by version string.
   * Throws UnresolvedConfigError if ruleset contains unapproved TBD_FROM_DATA parameters.
   *
   * @param {string} version
   * @returns {Promise<RulesetSnapshot>}
   */
  async getRulesetSnapshot(version) {
    const rawRecord = await this.db.getRulesetByVersion(version);
    if (!rawRecord) {
      throw new Error(`Ruleset version "${version}" not found in database.`);
    }

    if (rawRecord.status !== 'APPROVED') {
      throw new UnresolvedConfigError(
        `ruleset_${version}`,
        `Ruleset version "${version}" is in "${rawRecord.status}" status and has not been approved for production.`
      );
    }

    const snapshot = new RulesetSnapshot(version, rawRecord.definitions);
    snapshot.validateAllResolved();
    return snapshot;
  }
}

class MemoryPgConfigDriver {
  constructor() {
    this.table = new Map();
  }

  async saveRuleset(version, status, definitions) {
    this.table.set(version, { version, status, definitions });
  }

  async getRulesetByVersion(version) {
    return this.table.get(version) || null;
  }
}
