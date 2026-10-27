/**
 * V2 Economy Domain Contract Boundary
 */
import { FEATURE_FLAGS } from '../../core/feature-flags.js';
import {
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
} from './errors.js';
import { EconomyService } from './service.js';

export const DOMAIN_NAME = 'economy';
export const CURRENCY = 'DONG';
export const QUAN_TO_DONG = 600;

export const LEDGER_IDEMPOTENCY_UNIQUE_CONSTRAINT = 'uq_v2_ledger_entries_user_idempotency';

export const TRANSACTION_CLASSES = Object.freeze({
  FAUCET: 'FAUCET',
  SINK: 'SINK',
  TRANSFER: 'TRANSFER',
  SPECIAL: 'SPECIAL',
});

export const HOLD_PURPOSES = Object.freeze({
  CARD_MATCH: 'CARD_MATCH',
  EMPLOYMENT_WAGE: 'EMPLOYMENT_WAGE',
  THEFT_ESCROW: 'THEFT_ESCROW',
  COURT_ESCROW: 'COURT_ESCROW',
});

export const HOLD_STATUSES = Object.freeze({
  CREATED: 'CREATED',
  ACTIVE: 'ACTIVE',
  RELEASED: 'RELEASED',
  CAPTURED: 'CAPTURED',
});

export const REGISTERED_TRANSACTION_TYPES = Object.freeze([
  'faucet.grant',
  'sink.fee',
  'transfer.p2p',
  'hold.create',
  'hold.activate',
  'hold.release',
  'hold.capture',
]);

export const COMMAND_TYPES = Object.freeze({
  CREATE_WALLET: 'economy.create_wallet',
  GRANT_FAUCET: 'economy.grant_faucet',
  CHARGE_SINK: 'economy.charge_sink',
  TRANSFER_P2P: 'economy.transfer_p2p',
  CREATE_HOLD: 'economy.create_hold',
  ACTIVATE_HOLD: 'economy.activate_hold',
  RELEASE_HOLD: 'economy.release_hold',
  CAPTURE_HOLD: 'economy.capture_hold',
});

export const EVENT_TYPES = Object.freeze({
  WALLET_CREATED: 'economy.wallet_created',
  FAUCET_GRANTED: 'economy.faucet_granted',
  SINK_DEBITED: 'economy.sink_debited',
  TRANSFER_COMPLETED: 'economy.transfer_completed',
  HOLD_CREATED: 'economy.hold_created',
  HOLD_ACTIVATED: 'economy.hold_activated',
  HOLD_RELEASED: 'economy.hold_released',
  HOLD_CAPTURED: 'economy.hold_captured',
  LEDGER_ENTRY_RECORDED: 'economy.ledger_entry_recorded',
});

export const REQUIRED_FEATURE_FLAGS = Object.freeze([
  FEATURE_FLAGS.WALLET_V2,
]);

/**
 * Validates that an amount is a strict non-fractional integer đồng value.
 *
 * @param {number|string|bigint} amount
 * @param {boolean} [allowZero=false]
 * @returns {bigint} Normalized BigInt integer đồng
 */
export function validateIntegerDong(amount, allowZero = false) {
  if (amount === null || amount === undefined || typeof amount === 'boolean') {
    throw new InvalidAmountError(amount, 'Amount must be an integer đồng value.');
  }

  // Reject float strings or numbers with decimal points
  if (typeof amount === 'number') {
    if (!Number.isInteger(amount) || !Number.isSafeInteger(amount)) {
      throw new InvalidAmountError(amount, 'Amount must be a safe integer without floating-point decimals.');
    }
  } else if (typeof amount === 'string') {
    if (!/^-?\d+$/.test(amount.trim())) {
      throw new InvalidAmountError(amount, 'Amount string must contain only integer digits.');
    }
  }

  let val;
  try {
    val = BigInt(amount);
  } catch (_err) {
    throw new InvalidAmountError(amount, 'Unable to parse integer đồng value.');
  }

  if (allowZero) {
    if (val < 0n) {
      throw new InvalidAmountError(amount, 'Amount cannot be negative.');
    }
  } else {
    if (val <= 0n) {
      throw new InvalidAmountError(amount, 'Amount must be strictly positive (> 0).');
    }
  }

  return val;
}

/**
 * Pure display formatting helper converting authoritative integer đồng to quan/đồng string.
 * NOTE: Display formatting only. NEVER used for balance calculations or database storage.
 *
 * @param {number|string|bigint} dongAmount
 * @returns {string} Formatted display string (e.g., "2 quan", "1 quan 50 đồng", "100 đồng")
 */
export function formatQuanDisplay(dongAmount) {
  const val = validateIntegerDong(dongAmount, true);
  const quan = val / BigInt(QUAN_TO_DONG);
  const remainder = val % BigInt(QUAN_TO_DONG);

  if (quan > 0n && remainder > 0n) {
    return `${quan} quan ${remainder} đồng`;
  } else if (quan > 0n) {
    return `${quan} quan`;
  } else {
    return `${remainder} đồng`;
  }
}

/**
 * Validates transaction class against registered set.
 * @param {string} txClass
 * @returns {string} Validated transaction class
 */
export function validateTransactionClass(txClass) {
  if (!txClass || typeof txClass !== 'string') {
    throw new InvalidTransactionClassError(txClass);
  }
  const upper = txClass.trim().toUpperCase();
  if (!Object.values(TRANSACTION_CLASSES).includes(upper)) {
    throw new InvalidTransactionClassError(txClass);
  }
  return upper;
}

/**
 * Validates transaction type against registered set.
 * @param {string} txType
 * @returns {string} Validated transaction type
 */
export function validateTransactionType(txType) {
  if (!txType || typeof txType !== 'string' || txType.trim() === '') {
    throw new InvalidTransactionTypeError(txType, 'Type must be a non-empty string.');
  }
  const trimmed = txType.trim().toLowerCase();
  if (!REGISTERED_TRANSACTION_TYPES.includes(trimmed)) {
    throw new InvalidTransactionTypeError(txType, 'Type is not registered in frozen registry.');
  }
  return trimmed;
}

/**
 * Validates hold purpose against registered set.
 * @param {string} purpose
 * @returns {string} Validated hold purpose
 */
export function validateHoldPurpose(purpose) {
  if (!purpose || typeof purpose !== 'string') {
    throw new InvalidHoldPurposeError(purpose);
  }
  const upper = purpose.trim().toUpperCase();
  if (!Object.values(HOLD_PURPOSES).includes(upper)) {
    throw new InvalidHoldPurposeError(purpose);
  }
  return upper;
}

export function getDomainMetadata() {
  return {
    domain: DOMAIN_NAME,
    currency: CURRENCY,
    quanRatio: QUAN_TO_DONG,
    commandTypes: Object.values(COMMAND_TYPES),
    eventTypes: Object.values(EVENT_TYPES),
    transactionClasses: Object.values(TRANSACTION_CLASSES),
    registeredTransactionTypes: [...REGISTERED_TRANSACTION_TYPES],
    holdPurposes: Object.values(HOLD_PURPOSES),
    holdStatuses: Object.values(HOLD_STATUSES),
    requiredFlags: [...REQUIRED_FEATURE_FLAGS],
  };
}

export {
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
};
