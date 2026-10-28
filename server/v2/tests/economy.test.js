import test from 'node:test';
import assert from 'node:assert/strict';

import {
  CURRENCY,
  QUAN_TO_DONG,
  TRANSACTION_CLASSES,
  HOLD_PURPOSES,
  HOLD_STATUSES,
  REGISTERED_TRANSACTION_TYPES,
  FROZEN_ECONOMIC_TRANSACTION_TYPES,
  INTERNAL_HOLD_TRANSACTION_TYPES,
  TRANSACTION_TYPE_CLASS_MAP,
  validateIntegerDong,
  formatQuanDisplay,
  validateTransactionClass,
  validateTransactionType,
  validateHoldPurpose,
  getDomainMetadata,
  EconomyService,
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
  assert.ok(meta.frozenEconomicTypes.includes('SHOP_SALE'));
  assert.ok(meta.internalHoldTypes.includes('hold.activate'));
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

test('M3 Economy Domain: Frozen DOCX Class Mapping Integrity for all Transaction Types', () => {
  // FAUCET types
  const faucetTypes = ['SHOP_SALE', 'WHOLESALE_SALE', 'NPC_JOB_REWARD', 'CHAPTER_REWARD', 'MINIGAME_REWARD', 'JIGSAW_REWARD', 'EVENT_REWARD'];
  for (const t of faucetTypes) {
    assert.deepEqual(TRANSACTION_TYPE_CLASS_MAP[t], ['FAUCET']);
    assert.equal(validateTransactionType(t, 'FAUCET'), t);
    assert.throws(() => validateTransactionType(t, 'SINK'), InvalidTransactionClassError);
  }

  // SINK types (including NPC_WAGE, TAX, and SUU)
  const sinkTypes = ['STOCK_PURCHASE', 'SHOP_UPGRADE', 'HOUSE_PURCHASE', 'HOUSE_UPGRADE', 'FURNITURE_PURCHASE', 'NPC_WAGE', 'FORTUNE_TELLING_FEE', 'TAX', 'SUU', 'FINE', 'GUILD_DUES'];
  for (const t of sinkTypes) {
    assert.deepEqual(TRANSACTION_TYPE_CLASS_MAP[t], ['SINK']);
    assert.equal(validateTransactionType(t, 'SINK'), t);
    assert.throws(() => validateTransactionType(t, 'FAUCET'), InvalidTransactionClassError);
  }

  // TRANSFER types (RESTITUTION and COURT_COMPENSATION MUST BE TRANSFER!)
  const transferTypes = ['PLAYER_WAGE', 'GIFT', 'CARD_SETTLEMENT', 'THEFT', 'RESTITUTION', 'COURT_COMPENSATION'];
  for (const t of transferTypes) {
    assert.deepEqual(TRANSACTION_TYPE_CLASS_MAP[t], ['TRANSFER']);
    assert.equal(validateTransactionType(t, 'TRANSFER'), t);
    assert.throws(() => validateTransactionType(t, 'FAUCET'), InvalidTransactionClassError);
  }

  // SPECIAL types (LEGACY_IMPORT, ADMIN_ADJUSTMENT, REVERSAL, DISGORGE_ILLICIT_GAIN MUST BE SPECIAL!)
  const specialTypes = ['LEGACY_IMPORT', 'ADMIN_ADJUSTMENT', 'REVERSAL', 'DISGORGE_ILLICIT_GAIN'];
  for (const t of specialTypes) {
    assert.deepEqual(TRANSACTION_TYPE_CLASS_MAP[t], ['SPECIAL']);
    assert.equal(validateTransactionType(t, 'SPECIAL'), t);
    assert.throws(() => validateTransactionType(t, 'FAUCET'), InvalidTransactionClassError);
    assert.throws(() => validateTransactionType(t, 'SINK'), InvalidTransactionClassError);
  }

  // ANTI_CHEAT_FINE is strictly SPECIAL
  assert.deepEqual(TRANSACTION_TYPE_CLASS_MAP['ANTI_CHEAT_FINE'], ['SPECIAL']);
  assert.equal(validateTransactionType('ANTI_CHEAT_FINE', 'SPECIAL'), 'ANTI_CHEAT_FINE');
  assert.throws(() => validateTransactionType('ANTI_CHEAT_FINE', 'SINK'), InvalidTransactionClassError);
  assert.throws(() => validateTransactionType('ANTI_CHEAT_FINE', 'FAUCET'), InvalidTransactionClassError);
});

test('M3 Economy Domain: Rejects Omitted or Unregistered Transaction Types', () => {
  assert.throws(() => validateTransactionType(null), InvalidTransactionTypeError);
  assert.throws(() => validateTransactionType(''), InvalidTransactionTypeError);
  assert.throws(() => validateTransactionType('UNREGISTERED_TYPE'), InvalidTransactionTypeError);
});

test('M3 Economy Domain: Service Rejects Omitted Transaction Type on Faucet, Sink, and Transfer', async () => {
  const dummyDriver = { withTransaction: async () => {} };
  const service = new EconomyService({ pgDriver: dummyDriver });

  await assert.rejects(
    service.grantFaucet({ userId: 'u1', amount: 100 }),
    InvalidTransactionTypeError
  );

  await assert.rejects(
    service.chargeSink({ userId: 'u1', amount: 100 }),
    InvalidTransactionTypeError
  );

  await assert.rejects(
    service.transferP2P({ senderId: 'u1', recipientId: 'u2', amount: 100 }),
    InvalidTransactionTypeError
  );
});

test('M3 Economy Domain: Fail-Closed Registry Validators', () => {
  // Transaction Classes
  assert.equal(validateTransactionClass('FAUCET'), 'FAUCET');
  assert.equal(validateTransactionClass('sink'), 'SINK');
  assert.equal(validateTransactionClass('transfer'), 'TRANSFER');
  assert.equal(validateTransactionClass('special'), 'SPECIAL');
  assert.throws(() => validateTransactionClass('UNAPPROVED_CLASS'), InvalidTransactionClassError);

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
