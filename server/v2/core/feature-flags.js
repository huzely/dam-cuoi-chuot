/**
 * Feature Flags Primitive for V2 Server Foundation.
 * All V2 feature flags MUST default to false unless explicitly overridden.
 */

export const FEATURE_FLAGS = Object.freeze({
  ACCOUNT_V2: 'ACCOUNT_V2',
  WALLET_V2: 'WALLET_V2',
  MIGRATION_V2: 'MIGRATION_V2',
  EMPLOYMENT_V2: 'EMPLOYMENT_V2',
  TAX_V2: 'TAX_V2',
  FORTUNE_V2: 'FORTUNE_V2',
  HOI_XUAN_V2: 'HOI_XUAN_V2',
  CARD_WAGER: 'CARD_WAGER',
  GIFTS_V2: 'GIFTS_V2',
  THEFT_V2: 'THEFT_V2',
  COURT_V2: 'COURT_V2',
});

export class FeatureFlagService {
  /**
   * @param {Record<string, boolean>} [overrides={}]
   */
  constructor(overrides = {}) {
    this.flags = new Map();

    // Set defaults: ALL V2 feature flags default to false
    for (const flagKey of Object.values(FEATURE_FLAGS)) {
      this.flags.set(flagKey, false);
    }

    // Apply valid overrides
    for (const [key, val] of Object.entries(overrides)) {
      if (this.flags.has(key)) {
        this.flags.set(key, Boolean(val));
      } else {
        throw new Error(`Unknown feature flag: "${key}"`);
      }
    }
  }

  /**
   * Checks if a feature flag is enabled.
   * @param {string} flagKey
   * @returns {boolean}
   */
  isEnabled(flagKey) {
    if (!this.flags.has(flagKey)) {
      throw new Error(`Unregistered feature flag: "${flagKey}"`);
    }
    return this.flags.get(flagKey);
  }

  /**
   * Asserts that a feature flag is enabled.
   * Throws an error if disabled.
   * @param {string} flagKey
   */
  assertEnabled(flagKey) {
    if (!this.isEnabled(flagKey)) {
      throw new Error(`Feature flag "${flagKey}" is DISABLED.`);
    }
  }
}
