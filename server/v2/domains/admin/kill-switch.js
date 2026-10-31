/**
 * Kill Switch Control Primitive for V2 Admin Shell.
 * Provides emergency shutoff contracts for V2 feature capabilities.
 */

export class KillSwitchActiveError extends Error {
  constructor(switchKey) {
    super(`Emergency Kill Switch Active: Capability "${switchKey}" has been administratively disabled.`);
    this.name = 'KillSwitchActiveError';
    this.code = 'KILL_SWITCH_ACTIVE';
  }
}

export class KillSwitchService {
  /**
   * @param {Object} [dbClient]
   */
  constructor(dbClient = null) {
    this.table = new Map();
    this.db = dbClient;
  }

  /**
   * Checks if an emergency kill switch is active.
   * Default safe state: false (kill switch inactive / normal operation).
   *
   * @param {string} switchKey
   * @returns {Promise<boolean>}
   */
  async isKillSwitchActive(switchKey) {
    if (this.db) {
      const row = await this.db.getKillSwitchRow(switchKey);
      return row ? Boolean(row.active) : false;
    }
    return this.table.get(switchKey) || false;
  }

  /**
   * Asserts that a kill switch is NOT active. Throws KillSwitchActiveError if active.
   * @param {string} switchKey
   */
  async assertInactive(switchKey) {
    const active = await this.isKillSwitchActive(switchKey);
    if (active) {
      throw new KillSwitchActiveError(switchKey);
    }
  }

  /**
   * Sets emergency kill switch state.
   * @param {string} switchKey
   * @param {boolean} active
   */
  async setKillSwitch(switchKey, active) {
    const val = Boolean(active);
    if (this.db) {
      await this.db.setKillSwitchRow(switchKey, val);
    } else {
      this.table.set(switchKey, val);
    }
  }
}
