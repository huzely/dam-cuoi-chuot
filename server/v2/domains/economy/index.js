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

/**
 * Authoritative Frozen Economic Transaction Registry mapping every approved economic
 * mutation type to its compatible transaction class (FAUCET, SINK, TRANSFER).
 */
export const FROZEN_ECONOMIC_TRANSACTION_TYPES = Object.freeze({
  // FAUCET Class (authoritative money grant/credit)
  SHOP_SALE: { type: 'SHOP_SALE', class: 'FAUCET' },
  WHOLESALE_SALE: { type: 'WHOLESALE_SALE', class: 'FAUCET' },
  NPC_JOB_REWARD: { type: 'NPC_JOB_REWARD', class: 'FAUCET' },
  CHAPTER_REWARD: { type: 'CHAPTER_REWARD', class: 'FAUCET' },
  MINIGAME_REWARD: { type: 'MINIGAME_REWARD', class: 'FAUCET' },
  JIGSAW_REWARD: { type: 'JIGSAW_REWARD', class: 'FAUCET' },
  EVENT_REWARD: { type: 'EVENT_REWARD', class: 'FAUCET' },
  RESTITUTION: { type: 'RESTITUTION', class: 'FAUCET' },
  COURT_COMPENSATION: { type: 'COURT_COMPENSATION', class: 'FAUCET' },
  LEGACY_IMPORT: { type: 'LEGACY_IMPORT', class: 'FAUCET' },
  ADMIN_ADJUSTMENT: { type: 'ADMIN_ADJUSTMENT', class: 'FAUCET' },
  REVERSAL: { type: 'REVERSAL', class: 'FAUCET' },

  // SINK Class (authoritative money charge/debit)
  STOCK_PURCHASE: { type: 'STOCK_PURCHASE', class: 'SINK' },
  SHOP_UPGRADE: { type: 'SHOP_UPGRADE', class: 'SINK' },
  HOUSE_PURCHASE: { type: 'HOUSE_PURCHASE', class: 'SINK' },
  HOUSE_UPGRADE: { type: 'HOUSE_UPGRADE', class: 'SINK' },
  FURNITURE_PURCHASE: { type: 'FURNITURE_PURCHASE', class: 'SINK' },
  NPC_WAGE: { type: 'NPC_WAGE', class: 'SINK' },
  FORTUNE_TELLING_FEE: { type: 'FORTUNE_TELLING_FEE', class: 'SINK' },
  TAX: { type: 'TAX', class: 'SINK' },
  SUU: { type: 'SUU', class: 'SINK' },
  FINE: { type: 'FINE', class: 'SINK' },
  GUILD_DUES: { type: 'GUILD_DUES', class: 'SINK' },
  DISGORGE_ILLICIT_GAIN: { type: 'DISGORGE_ILLICIT_GAIN', class: 'SINK' },
  ANTI_CHEAT_FINE: { type: 'ANTI_CHEAT_FINE', class: 'SINK' },

  // TRANSFER Class (peer-to-peer / account-to-account value conservation)
  PLAYER_WAGE: { type: 'PLAYER_WAGE', class: 'TRANSFER' },
  GIFT: { type: 'GIFT', class: 'TRANSFER' },
  CARD_SETTLEMENT: { type: 'CARD_SETTLEMENT', class: 'TRANSFER' },
  THEFT: { type: 'THEFT', class: 'TRANSFER' },
});

/**
 * Separate Internal Hold Lifecycle Bookkeeping Types (NOT generic economic mutations).
 */
export const INTERNAL_HOLD_BOOKKEEPING_TYPES = Object.freeze([
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
 * Validates an economic transaction type against the frozen economic registry
 * and verifies class compatibility.
 *
 * @param {string} type
 * @param {string} [expectedClass=null] - Expected class ('FAUCET', 'SINK', 'TRANSFER', 'SPECIAL')
 * @returns {string} Validated transaction type string
 */
export function validateEconomicTransactionType(type, expectedClass = null) {
  if (!type || typeof type !== 'string' || type.trim() === '') {
    throw new InvalidTransactionTypeError(type, 'Type must be a non-empty string.');
  }

  const trimmed = type.trim();
  const lower = trimmed.toLowerCase();
  const upper = trimmed.toUpperCase();

  // Allow internal hold bookkeeping types if expectedClass is SPECIAL or not specified
  if (INTERNAL_HOLD_BOOKKEEPING_TYPES.includes(lower)) {
    if (expectedClass && expectedClass.toUpperCase() !== 'SPECIAL') {
      throw new InvalidTransactionTypeError(type, `Internal hold bookkeeping type "${type}" is incompatible with transaction class "${expectedClass}".`);
    }
    return lower;
  }

  const spec = FROZEN_ECONOMIC_TRANSACTION_TYPES[upper];
  if (!spec) {
    throw new InvalidTransactionTypeError(type, `Transaction type "${type}" is not registered in frozen economic transaction registry.`);
  }

  if (expectedClass) {
    const normalizedExpectedClass = validateTransactionClass(expectedClass);
    if (spec.class !== normalizedExpectedClass) {
      throw new InvalidTransactionTypeError(
        type,
        `Transaction type "${upper}" has registered class "${spec.class}", which is incompatible with requested class "${normalizedExpectedClass}".`
      );
    }
  }

  return upper;
}

/**
 * Legacy validator maintained for backwards compatibility.
 * @param {string} txType
 * @returns {string}
 */
export function validateTransactionType(txType) {
  return validateEconomicTransactionType(txType);
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
    frozenEconomicTypes: Object.keys(FROZEN_ECONOMIC_TRANSACTION_TYPES),
    internalBookkeepingTypes: [...INTERNAL_HOLD_BOOKKEEPING_TYPES],
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
