/**
 * Configuration & Ruleset Versioning Primitive for V2.
 *
 * Categories:
 * - STATIC_RULE: Fixed gameplay mechanics or structural rules.
 * - ECONOMY_CONFIG: Approved economic parameters (prices, rewards, multiplier tiers).
 * - QTV_CONFIG: Administrative operational thresholds and rate limits.
 * - TBD_FROM_DATA: Intentionally undecided balance values requiring telemetry,
 *   economy analysis, simulation, or human approval.
 *
 * INVARIANT: Unresolved TBD_FROM_DATA values MUST FAIL CLOSED.
 * Attempting to resolve an unapproved TBD_FROM_DATA parameter throws UnresolvedConfigError.
 * Sessions snapshot approved ruleset versions and cannot invent missing TBD_FROM_DATA values.
 */

export const CONFIG_CATEGORIES = Object.freeze({
  STATIC_RULE: 'STATIC_RULE',
  ECONOMY_CONFIG: 'ECONOMY_CONFIG',
  QTV_CONFIG: 'QTV_CONFIG',
  TBD_FROM_DATA: 'TBD_FROM_DATA',
});

export class UnresolvedConfigError extends Error {
  constructor(configKey, reason = 'Parameter value is TBD_FROM_DATA and requires telemetry, economy analysis, or human approval before enabling.') {
    super(`Unresolved Configuration Error for "${configKey}": ${reason}`);
    this.name = 'UnresolvedConfigError';
    this.code = 'UNRESOLVED_CONFIG_PARAMETER';
    this.configKey = configKey;
  }
}

export class RulesetSnapshot {
  /**
   * @param {string} version - Ruleset version identifier (e.g., '1.0.0')
   * @param {Record<string, { category: string, value: any, description?: string }>} definitions
   */
  constructor(version, definitions = {}) {
    if (!version || typeof version !== 'string') {
      throw new Error('RulesetSnapshot requires a valid version string.');
    }
    this.version = version;
    this.definitions = new Map();

    for (const [key, def] of Object.entries(definitions)) {
      if (!def || !def.category || !Object.values(CONFIG_CATEGORIES).includes(def.category)) {
        throw new Error(`Invalid category "${def?.category}" for config key "${key}".`);
      }
      this.definitions.set(key, Object.freeze({ ...def }));
    }
    Object.freeze(this);
  }

  /**
   * Resolves a configuration parameter value from this snapshot.
   * Throws UnresolvedConfigError if the property is TBD_FROM_DATA and unresolved.
   *
   * @param {string} key
   * @returns {any}
   */
  get(key) {
    const entry = this.definitions.get(key);
    if (!entry) {
      throw new Error(`Configuration key "${key}" not found in ruleset version "${this.version}".`);
    }

    if (entry.category === CONFIG_CATEGORIES.TBD_FROM_DATA || entry.value === CONFIG_CATEGORIES.TBD_FROM_DATA) {
      throw new UnresolvedConfigError(key, entry.description);
    }

    return entry.value;
  }

  /**
   * Validates that all parameters in this snapshot are fully resolved.
   * Useful for pre-flight checking before starting an economic/competitive session.
   */
  validateAllResolved() {
    const unresolved = [];
    for (const [key, entry] of this.definitions.entries()) {
      if (entry.category === CONFIG_CATEGORIES.TBD_FROM_DATA || entry.value === CONFIG_CATEGORIES.TBD_FROM_DATA) {
        unresolved.push(key);
      }
    }

    if (unresolved.length > 0) {
      throw new UnresolvedConfigError(
        unresolved.join(', '),
        `Ruleset version "${this.version}" contains ${unresolved.length} unresolved TBD_FROM_DATA parameters: [${unresolved.join(', ')}]. Session cannot start.`
      );
    }
    return true;
  }
}
