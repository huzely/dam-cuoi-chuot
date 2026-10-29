/**
 * V2 Economy Domain Custom Errors
 */

export class InsufficientBalanceError extends Error {
  constructor(userId, required, available) {
    super(`Insufficient available balance for user "${userId}". Required: ${required}, Available: ${available}.`);
    this.name = 'InsufficientBalanceError';
    this.code = 'INSUFFICIENT_BALANCE';
    this.userId = userId;
    this.required = required;
    this.available = available;
  }
}

export class WalletNotFoundError extends Error {
  constructor(userId) {
    super(`Wallet not found for user "${userId}".`);
    this.name = 'WalletNotFoundError';
    this.code = 'WALLET_NOT_FOUND';
    this.userId = userId;
  }
}

export class WalletConcurrencyError extends Error {
  constructor(userId, currentVersion) {
    super(`Concurrent modification detected for wallet "${userId}" (version ${currentVersion}).`);
    this.name = 'WalletConcurrencyError';
    this.code = 'WALLET_CONCURRENCY_ERROR';
    this.userId = userId;
    this.currentVersion = currentVersion;
  }
}

export class InvalidAmountError extends Error {
  constructor(amount, reason = 'Amount must be a positive integer đồng.') {
    super(`Invalid amount "${amount}": ${reason}`);
    this.name = 'InvalidAmountError';
    this.code = 'INVALID_AMOUNT';
    this.amount = amount;
  }
}

export class InvalidHoldStatusError extends Error {
  constructor(holdId, currentStatus, targetStatus, action = 'transition hold status') {
    super(`Cannot ${action} for hold "${holdId}": Current status "${currentStatus}" cannot transition to "${targetStatus}".`);
    this.name = 'InvalidHoldStatusError';
    this.code = 'INVALID_HOLD_STATUS';
    this.holdId = holdId;
    this.currentStatus = currentStatus;
    this.targetStatus = targetStatus;
  }
}

export class InvalidHoldPurposeError extends Error {
  constructor(purpose) {
    super(`Invalid hold purpose "${purpose}". Supported purposes: CARD_MATCH, EMPLOYMENT_WAGE, THEFT_ESCROW, COURT_ESCROW.`);
    this.name = 'InvalidHoldPurposeError';
    this.code = 'INVALID_HOLD_PURPOSE';
    this.purpose = purpose;
  }
}

export class HoldNotFoundError extends Error {
  constructor(holdId) {
    super(`Hold record not found for holdId "${holdId}".`);
    this.name = 'HoldNotFoundError';
    this.code = 'HOLD_NOT_FOUND';
    this.holdId = holdId;
  }
}

export class InvalidTransactionClassError extends Error {
  constructor(txClass) {
    super(`Invalid transaction class "${txClass}". Supported classes: FAUCET, SINK, TRANSFER, SPECIAL.`);
    this.name = 'InvalidTransactionClassError';
    this.code = 'INVALID_TRANSACTION_CLASS';
    this.txClass = txClass;
  }
}

export class InvalidTransactionTypeError extends Error {
  constructor(txType, reason = 'Unregistered or invalid transaction type.') {
    super(`Invalid transaction type "${txType}": ${reason}`);
    this.name = 'InvalidTransactionTypeError';
    this.code = 'INVALID_TRANSACTION_TYPE';
    this.txType = txType;
  }
}

export class TransferConservationError extends Error {
  constructor(reason = 'Transfer sum of deltas must equal zero.') {
    super(`Transfer Conservation Failure: ${reason}`);
    this.name = 'TransferConservationError';
    this.code = 'TRANSFER_CONSERVATION_ERROR';
  }
}

export class DuplicateLedgerIdempotencyError extends Error {
  constructor(userId, idempotencyKey) {
    super(`Duplicate ledger entry for user "${userId}" with idempotency key "${idempotencyKey}".`);
    this.name = 'DuplicateLedgerIdempotencyError';
    this.code = 'DUPLICATE_LEDGER_IDEMPOTENCY';
    this.userId = userId;
    this.idempotencyKey = idempotencyKey;
  }
}
