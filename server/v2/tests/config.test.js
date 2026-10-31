import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CONFIG_CATEGORIES,
  RulesetSnapshot,
  UnresolvedConfigError,
} from '../core/config.js';

test('RulesetSnapshot resolves approved STATIC_RULE and ECONOMY_CONFIG parameters', () => {
  const snapshot = new RulesetSnapshot('1.0.0', {
    'MAX_PARTY_SIZE': {
      category: CONFIG_CATEGORIES.STATIC_RULE,
      value: 4,
    },
    'FESTIVAL_BOOTH_ENTRY_FEE': {
      category: CONFIG_CATEGORIES.ECONOMY_CONFIG,
      value: 10,
    },
  });

  assert.equal(snapshot.get('MAX_PARTY_SIZE'), 4);
  assert.equal(snapshot.get('FESTIVAL_BOOTH_ENTRY_FEE'), 10);
  assert.equal(snapshot.validateAllResolved(), true);
});

test('RulesetSnapshot fails closed on unresolved TBD_FROM_DATA parameters', () => {
  const snapshot = new RulesetSnapshot('1.0.0-draft', {
    'MAX_PARTY_SIZE': {
      category: CONFIG_CATEGORIES.STATIC_RULE,
      value: 4,
    },
    'THEFT_CAP_AMOUNT': {
      category: CONFIG_CATEGORIES.TBD_FROM_DATA,
      value: CONFIG_CATEGORIES.TBD_FROM_DATA,
      description: 'Theft cap amount awaiting telemetry and human approval',
    },
  });

  assert.equal(snapshot.get('MAX_PARTY_SIZE'), 4);

  // Attempting to resolve TBD_FROM_DATA parameter must throw UnresolvedConfigError
  assert.throws(() => {
    snapshot.get('THEFT_CAP_AMOUNT');
  }, (err) => {
    return err instanceof UnresolvedConfigError && err.configKey === 'THEFT_CAP_AMOUNT';
  });

  // Pre-flight check validateAllResolved must fail closed
  assert.throws(() => {
    snapshot.validateAllResolved();
  }, UnresolvedConfigError);
});

test('RulesetSnapshot version snapshotting guarantees isolation from live updates', () => {
  const sessionSnapshot = new RulesetSnapshot('1.0.0', {
    'ENTRY_FEE': {
      category: CONFIG_CATEGORIES.ECONOMY_CONFIG,
      value: 10,
    },
  });

  // Imagine global live config updates to version 1.1.0 with new values
  const updatedGlobalConfig = new RulesetSnapshot('1.1.0', {
    'ENTRY_FEE': {
      category: CONFIG_CATEGORIES.ECONOMY_CONFIG,
      value: 20, // Changed fee
    },
  });

  // Running session snapshot remains isolated and retains version 1.0.0 fee
  assert.equal(sessionSnapshot.get('ENTRY_FEE'), 10);
  assert.equal(updatedGlobalConfig.get('ENTRY_FEE'), 20);
});
