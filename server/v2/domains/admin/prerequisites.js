/**
 * Feature Prerequisite Registry Primitive for V2 Admin Shell.
 * Ensures feature flags cannot be enabled if required config parameters are unresolved or TBD_FROM_DATA.
 */

import { UnresolvedConfigError } from '../../core/config.js';

export class FeaturePrerequisiteRegistry {
  constructor() {
    /** @type {Map<string, Set<string>>} */
    this.prerequisites = new Map();
  }

  /**
   * Registers required config keys for a given feature flag.
   * @param {string} flagKey
   * @param {Array<string>} configKeys
   */
  registerPrerequisites(flagKey, configKeys = []) {
    if (!this.prerequisites.has(flagKey)) {
      this.prerequisites.set(flagKey, new Set());
    }
    const set = this.prerequisites.get(flagKey);
    for (const key of configKeys) {
      set.add(key);
    }
  }

  /**
   * Checks if all prerequisite configuration parameters for a feature flag are resolved.
   * Throws UnresolvedConfigError if any prerequisite parameter is TBD_FROM_DATA or missing.
   *
   * @param {string} flagKey
   * @param {Object} rulesetSnapshot - RulesetSnapshot instance
   */
  checkPrerequisites(flagKey, rulesetSnapshot) {
    const requiredKeys = this.prerequisites.get(flagKey);
    if (!requiredKeys || requiredKeys.size === 0) {
      return true; // No prerequisites registered for this flag
    }

    for (const configKey of requiredKeys) {
      try {
        rulesetSnapshot.get(configKey);
      } catch (err) {
        throw new UnresolvedConfigError(
          configKey,
          `Cannot enable feature flag "${flagKey}": Prerequisite configuration parameter "${configKey}" is unresolved or TBD_FROM_DATA.`
        );
      }
    }
    return true;
  }
}
