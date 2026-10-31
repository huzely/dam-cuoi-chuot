import test from 'node:test';
import assert from 'node:assert/strict';
import { FeatureFlagService, FEATURE_FLAGS } from '../core/feature-flags.js';

test('FeatureFlagService: all V2 flags default to false', () => {
  const flags = new FeatureFlagService();

  const expectedFlags = [
    'ACCOUNT_V2',
    'WALLET_V2',
    'MIGRATION_V2',
    'EMPLOYMENT_V2',
    'TAX_V2',
    'FORTUNE_V2',
    'HOI_XUAN_V2',
    'CARD_WAGER',
    'GIFTS_V2',
    'THEFT_V2',
    'COURT_V2',
  ];

  for (const flagKey of expectedFlags) {
    assert.equal(flags.isEnabled(FEATURE_FLAGS[flagKey]), false, `Flag ${flagKey} must default to false`);
    assert.throws(() => {
      flags.assertEnabled(FEATURE_FLAGS[flagKey]);
    }, /is DISABLED/);
  }
});

test('FeatureFlagService: supports explicit overrides for testing', () => {
  const flags = new FeatureFlagService({
    [FEATURE_FLAGS.ACCOUNT_V2]: true,
    [FEATURE_FLAGS.HOI_XUAN_V2]: true,
  });

  assert.equal(flags.isEnabled(FEATURE_FLAGS.ACCOUNT_V2), true);
  assert.equal(flags.isEnabled(FEATURE_FLAGS.HOI_XUAN_V2), true);
  assert.equal(flags.isEnabled(FEATURE_FLAGS.WALLET_V2), false);

  assert.doesNotThrow(() => {
    flags.assertEnabled(FEATURE_FLAGS.HOI_XUAN_V2);
  });
});

test('FeatureFlagService: throws error for unknown feature flags', () => {
  const flags = new FeatureFlagService();
  assert.throws(() => {
    flags.isEnabled('NON_EXISTENT_FLAG');
  }, /Unregistered feature flag/);

  assert.throws(() => {
    new FeatureFlagService({ 'INVALID_FLAG': true });
  }, /Unknown feature flag/);
});
