import test from 'node:test';
import assert from 'node:assert/strict';

import {
  CURRENCY,
  QUAN_TO_DONG,
  TRANSACTION_CLASSES,
  HOLD_PURPOSES,
  HOLD_STATUSES,
  FROZEN_ECONOMIC_TRANSACTION_TYPES,
  INTERNAL_HOLD_BOOKKEEPING_TYPES,
  validateIntegerDong,
  formatQuanDisplay,
  validateTransactionClass,
  validateEconomicTransactionType,
  validateHoldPurpose,
  getDomainMetadata,
  InsufficientBalanceError,
  WalletNotFoundError,
  WalletConcurrencyError,
  InvalidAmountError,
  InvalidHoldStatusError,
  InvalidHoldPurposeError,
  HoldNotFoundError,
  InvalidTransactionClassError,
  InvalidTransactionTypeError,
  TransferConservationError,
  DuplicateLedgerIdempotencyError,
} from '../domains/economy/index.js';

test('M3 Economy Domain: Constants and Telemetry Metadata', () => {
  const meta = getDomainMetadata();
  assert.equal(meta.domain, 'economy');
  assert.equal(meta.currency, 'DONG');
  assert.equal(meta.quanRatio, 600);
  assert.ok(meta.commandTypes.includes('economy.grant_faucet'));
  assert.ok(meta.eventTypes.includes('economy.transfer_completed'));
  assert.ok(meta.transactionClasses.includes('FAUCET'));
  assert.ok(meta.frozenEconomicTypes.includes('CHAPTER_REWARD'));
  assert.ok(meta.internalBookkeepingTypes.includes('hold.activate'));
  assert.ok(meta.holdPurposes.includes('CARD_MATCH'));
  assert.ok(meta.holdStatuses.includes('CREATED'));
});

test('M3 Economy Domain: Integer đồng validation (No Float Storage)', () => {
  assert.equal(validateIntegerDong(100), 100n);
  assert.equal(validateIntegerDong('600'), 600n);
  assert.equal(validateIntegerDong(1200n), 1200n);
  assert.equal(validateIntegerDong(0, true), 0n);

  // Rejects floats
  assert.throws(() => validateIntegerDong(10.5), InvalidAmountError);
  assert.throws(() => validateIntegerDong('12.34'), InvalidAmountError);

  // Rejects negative/zero when allowZero is false
  assert.throws(() => validateIntegerDong(0), InvalidAmountError);
  assert.throws(() => validateIntegerDong(-50), InvalidAmountError);

  // Rejects invalid non-numeric inputs
  assert.throws(() => validateIntegerDong('abc'), InvalidAmountError);
  assert.throws(() => validateIntegerDong(null), InvalidAmountError);
  assert.throws(() => validateIntegerDong(true), InvalidAmountError);
});

test('M3 Economy Domain: Pure Quan Display Formatting (600 đồng = 1 quan)', () => {
  assert.equal(formatQuanDisplay(600), '1 quan');
  assert.equal(formatQuanDisplay(1200), '2 quan');
  assert.equal(formatQuanDisplay(1250), '2 quan 50 đồng');
  assert.equal(formatQuanDisplay(50), '50 đồng');
  assert.equal(formatQuanDisplay(0), '0 đồng');
  assert.equal(formatQuanDisplay('1805'), '3 quan 5 đồng');
});

test('M3 Economy Domain: Fail-Closed Frozen Economic Transaction Registry Validators', () => {
  // Transaction Classes
  assert.equal(validateTransactionClass('FAUCET'), 'FAUCET');
  assert.equal(validateTransactionClass('sink'), 'SINK');
  assert.equal(validateTransactionClass('transfer'), 'TRANSFER');
  assert.equal(validateTransactionClass('special'), 'SPECIAL');
  assert.throws(() => validateTransactionClass('UNAPPROVED_CLASS'), InvalidTransactionClassError);

  // Valid Frozen Economic Types
  assert.equal(validateEconomicTransactionType('CHAPTER_REWARD', 'FAUCET'), 'CHAPTER_REWARD');
  assert.equal(validateEconomicTransactionType('SHOP_UPGRADE', 'SINK'), 'SHOP_UPGRADE');
  assert.equal(validateEconomicTransactionType('PLAYER_WAGE', 'TRANSFER'), 'PLAYER_WAGE');
  assert.equal(validateEconomicTransactionType('ANTI_CHEAT_FINE', 'SPECIAL'), 'ANTI_CHEAT_FINE');
  assert.equal(validateEconomicTransactionType('ANTI_CHEAT_FINE', 'SINK'), 'ANTI_CHEAT_FINE');
  assert.equal(validateEconomicTransactionType('hold.activate', 'SPECIAL'), 'hold.activate');

  // Class Enforcement & Dual Compatibility Rules
  assert.throws(() => validateEconomicTransactionType('ANTI_CHEAT_FINE', 'FAUCET'), InvalidTransactionTypeError);
  assert.throws(() => validateEconomicTransactionType('ANTI_CHEAT_FINE', 'TRANSFER'), InvalidTransactionTypeError);
  assert.throws(() => validateEconomicTransactionType('CHAPTER_REWARD', 'SINK'), InvalidTransactionTypeError);
  assert.throws(() => validateEconomicTransactionType('SHOP_UPGRADE', 'FAUCET'), InvalidTransactionTypeError);
  assert.throws(() => validateEconomicTransactionType('PLAYER_WAGE', 'SINK'), InvalidTransactionTypeError);

  // Unknown Economic Type Rejection
  assert.throws(() => validateEconomicTransactionType('UNREGISTERED_CUSTOM_TYPE'), InvalidTransactionTypeError);

  // Hold Purposes
  assert.equal(validateHoldPurpose('CARD_MATCH'), 'CARD_MATCH');
  assert.equal(validateHoldPurpose('employment_wage'), 'EMPLOYMENT_WAGE');
  assert.equal(validateHoldPurpose('theft_escrow'), 'THEFT_ESCROW');
  assert.equal(validateHoldPurpose('court_escrow'), 'COURT_ESCROW');
  assert.throws(() => validateHoldPurpose('UNAPPROVED_PURPOSE'), InvalidHoldPurposeError);
});

test('M3 Economy Domain: Custom Error Codes and Properties', () => {
  const insuf = new InsufficientBalanceError('usr_1', '1000', '500');
  assert.equal(insuf.code, 'INSUFFICIENT_BALANCE');
  assert.equal(insuf.userId, 'usr_1');

  const wNotF = new WalletNotFoundError('usr_2');
  assert.equal(wNotF.code, 'WALLET_NOT_FOUND');

  const wConc = new WalletConcurrencyError('usr_3', 5);
  assert.equal(wConc.code, 'WALLET_CONCURRENCY_ERROR');

  const hStat = new InvalidHoldStatusError('hold_1', 'RELEASED', 'ACTIVE', 'activate hold');
  assert.equal(hStat.code, 'INVALID_HOLD_STATUS');

  const xferCons = new TransferConservationError('Deltas mismatch');
  assert.equal(xferCons.code, 'TRANSFER_CONSERVATION_ERROR');

  const dupLedger = new DuplicateLedgerIdempotencyError('usr_4', 'key_123');
  assert.equal(dupLedger.code, 'DUPLICATE_LEDGER_IDEMPOTENCY');
});
