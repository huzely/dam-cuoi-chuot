/**
 * V2 Economy Domain Service.
 * Manages V2 Wallets, Ledger Entries, Holds/Escrow lifecycle, value conservation,
 * optimistic concurrency control, and transactional outbox events.
 */

import crypto from 'node:crypto';
import { MissingDatabaseDriverError } from '../../adapters/pg-idempotency.js';
import { createDomainEvent } from '../../core/event.js';
import {
  EVENT_TYPES,
  HOLD_STATUSES,
  LEDGER_IDEMPOTENCY_UNIQUE_CONSTRAINT,
  validateIntegerDong,
  validateTransactionClass,
  validateTransactionType,
  validateHoldPurpose,
  InsufficientBalanceError,
  WalletNotFoundError,
  WalletConcurrencyError,
  InvalidHoldStatusError,
  HoldNotFoundError,
  TransferConservationError,
  DuplicateLedgerIdempotencyError,
} from './index.js';

export class EconomyService {
  /**
   * @param {Object} params
   * @param {Object} params.pgDriver - PostgreSQL Driver adapter (REQUIRED)
   */
  constructor({ pgDriver }) {
    if (!pgDriver) {
      throw new MissingDatabaseDriverError('EconomyService');
    }
    this.pgDriver = pgDriver;
  }

  /**
   * Helper to execute work inside active transaction or start a new one.
   */
  async _withTx(tx, workFn) {
    if (tx) {
      return await workFn(tx);
    }
    return await this.pgDriver.withTransaction(workFn);
  }

  /**
   * Creates a V2 wallet for a target user account.
   *
   * @param {string} userId - UUID user_id
   * @param {Object} [tx] - Optional active transaction handle
   * @returns {Promise<Object>} Created wallet record
   */
  async createWallet(userId, tx = null) {
    if (!userId || typeof userId !== 'string') {
      throw new Error('Valid user_id required to create wallet.');
    }

    return await this._withTx(tx, async (activeTx) => {
      const existing = await activeTx.wallets.getByUserId(userId);
      if (existing) {
        return existing;
      }

      const wallet = await activeTx.wallets.create({ userId });

      const event = createDomainEvent({
        eventType: EVENT_TYPES.WALLET_CREATED,
        aggregate: { type: 'wallet', id: userId },
        payload: {
          userId,
          availableBalance: wallet.availableBalance.toString(),
          lockedBalance: wallet.lockedBalance.toString(),
          version: wallet.version,
          createdAt: wallet.createdAt,
        },
      });
      activeTx.outbox.record(event);

      return wallet;
    });
  }

  /**
   * Retrieves a V2 wallet by user_id.
   *
   * @param {string} userId
   * @param {Object} [tx]
   * @returns {Promise<Object|null>} Wallet record or null
   */
  async getWallet(userId, tx = null) {
    if (!userId || typeof userId !== 'string') {
      return null;
    }

    return await this._withTx(tx, async (activeTx) => {
      return await activeTx.wallets.getByUserId(userId);
    });
  }

  /**
   * Grants authoritative money (FAUCET class).
   */
  async grantFaucet({
    userId,
    amount,
    type = 'faucet.grant',
    source = 'system',
    referenceId = null,
    metadata = {},
    idempotencyKey = null,
    configVersion = null,
  }, tx = null) {
    if (!userId || typeof userId !== 'string') {
      throw new Error('Valid user_id required for faucet grant.');
    }

    const valAmount = validateIntegerDong(amount);
    const validClass = validateTransactionClass('FAUCET');
    const validType = validateTransactionType(type);

    return await this._withTx(tx, async (activeTx) => {
      let wallet = await activeTx.wallets.getByUserId(userId);
      if (!wallet) {
        wallet = await activeTx.wallets.create({ userId });
      }

      const newAvailable = BigInt(wallet.availableBalance) + valAmount;
      const updatedWallet = await activeTx.wallets.updateBalanceWithOptimisticLock(userId, {
        availableBalance: newAvailable,
        lockedBalance: wallet.lockedBalance,
        expectedVersion: wallet.version,
      });

      if (!updatedWallet) {
        throw new WalletConcurrencyError(userId, wallet.version);
      }

      const transactionId = crypto.randomUUID();
      let ledgerEntry;
      try {
        ledgerEntry = await activeTx.ledger.recordEntry({
          transactionId,
          userId,
          amount: valAmount,
          balanceAfter: newAvailable,
          class: validClass,
          type: validType,
          source,
          referenceId,
          counterparty: null,
          metadata,
          idempotencyKey,
          configVersion,
        });
      } catch (err) {
        if (err.code === '23505' && (err.constraint === LEDGER_IDEMPOTENCY_UNIQUE_CONSTRAINT || err.message?.includes('uq_v2_ledger_entries_user_idempotency'))) {
          throw new DuplicateLedgerIdempotencyError(userId, idempotencyKey);
        }
        throw err;
      }

      const faucetEvent = createDomainEvent({
        eventType: EVENT_TYPES.FAUCET_GRANTED,
        aggregate: { type: 'wallet', id: userId },
        payload: {
          transactionId,
          userId,
          amount: valAmount.toString(),
          availableBalance: newAvailable.toString(),
          type: validType,
          source,
          referenceId,
          idempotencyKey,
        },
      });
      activeTx.outbox.record(faucetEvent);

      return { wallet: updatedWallet, ledgerEntry };
    });
  }

  /**
   * Debits authoritative money (SINK class).
   */
  async chargeSink({
    userId,
    amount,
    type = 'sink.fee',
    source = 'system',
    referenceId = null,
    metadata = {},
    idempotencyKey = null,
    configVersion = null,
  }, tx = null) {
    if (!userId || typeof userId !== 'string') {
      throw new Error('Valid user_id required for sink charge.');
    }

    const valAmount = validateIntegerDong(amount);
    const validClass = validateTransactionClass('SINK');
    const validType = validateTransactionType(type);

    return await this._withTx(tx, async (activeTx) => {
      const wallet = await activeTx.wallets.getByUserId(userId);
      if (!wallet) {
        throw new WalletNotFoundError(userId);
      }

      const currentAvailable = BigInt(wallet.availableBalance);
      if (currentAvailable < valAmount) {
        throw new InsufficientBalanceError(userId, valAmount.toString(), currentAvailable.toString());
      }

      const newAvailable = currentAvailable - valAmount;
      const updatedWallet = await activeTx.wallets.updateBalanceWithOptimisticLock(userId, {
        availableBalance: newAvailable,
        lockedBalance: wallet.lockedBalance,
        expectedVersion: wallet.version,
      });

      if (!updatedWallet) {
        throw new WalletConcurrencyError(userId, wallet.version);
      }

      const transactionId = crypto.randomUUID();
      let ledgerEntry;
      try {
        ledgerEntry = await activeTx.ledger.recordEntry({
          transactionId,
          userId,
          amount: -valAmount, // Negative delta for debit
          balanceAfter: newAvailable,
          class: validClass,
          type: validType,
          source,
          referenceId,
          counterparty: null,
          metadata,
          idempotencyKey,
          configVersion,
        });
      } catch (err) {
        if (err.code === '23505' && (err.constraint === LEDGER_IDEMPOTENCY_UNIQUE_CONSTRAINT || err.message?.includes('uq_v2_ledger_entries_user_idempotency'))) {
          throw new DuplicateLedgerIdempotencyError(userId, idempotencyKey);
        }
        throw err;
      }

      const sinkEvent = createDomainEvent({
        eventType: EVENT_TYPES.SINK_DEBITED,
        aggregate: { type: 'wallet', id: userId },
        payload: {
          transactionId,
          userId,
          amount: valAmount.toString(),
          availableBalance: newAvailable.toString(),
          type: validType,
          source,
          referenceId,
          idempotencyKey,
        },
      });
      activeTx.outbox.record(sinkEvent);

      return { wallet: updatedWallet, ledgerEntry };
    });
  }

  /**
   * Authoritative Peer-to-Peer Transfer (TRANSFER class).
   * Double-entry semantics: Sum of deltas MUST equal ZERO.
   */
  async transferP2P({
    senderId,
    recipientId,
    amount,
    type = 'transfer.p2p',
    source = 'p2p',
    referenceId = null,
    metadata = {},
    idempotencyKey = null,
    configVersion = null,
  }, tx = null) {
    if (!senderId || typeof senderId !== 'string') {
      throw new Error('Valid senderId required for P2P transfer.');
    }
    if (!recipientId || typeof recipientId !== 'string') {
      throw new Error('Valid recipientId required for P2P transfer.');
    }
    if (senderId === recipientId) {
      throw new Error('Sender and recipient must be distinct accounts for P2P transfer.');
    }

    const valAmount = validateIntegerDong(amount);
    const validClass = validateTransactionClass('TRANSFER');
    const validType = validateTransactionType(type);

    return await this._withTx(tx, async (activeTx) => {
      const senderWallet = await activeTx.wallets.getByUserId(senderId);
      if (!senderWallet) {
        throw new WalletNotFoundError(senderId);
      }

      let recipientWallet = await activeTx.wallets.getByUserId(recipientId);
      if (!recipientWallet) {
        recipientWallet = await activeTx.wallets.create({ userId: recipientId });
      }

      const senderAvailable = BigInt(senderWallet.availableBalance);
      if (senderAvailable < valAmount) {
        throw new InsufficientBalanceError(senderId, valAmount.toString(), senderAvailable.toString());
      }

      // Transfer Value Conservation Enforcement
      const senderDelta = -valAmount;
      const recipientDelta = +valAmount;
      if (senderDelta + recipientDelta !== 0n) {
        throw new TransferConservationError('Sum of transfer deltas is non-zero.');
      }

      const newSenderAvailable = senderAvailable - valAmount;
      const newRecipientAvailable = BigInt(recipientWallet.availableBalance) + valAmount;

      const updatedSender = await activeTx.wallets.updateBalanceWithOptimisticLock(senderId, {
        availableBalance: newSenderAvailable,
        lockedBalance: senderWallet.lockedBalance,
        expectedVersion: senderWallet.version,
      });
      if (!updatedSender) {
        throw new WalletConcurrencyError(senderId, senderWallet.version);
      }

      const updatedRecipient = await activeTx.wallets.updateBalanceWithOptimisticLock(recipientId, {
        availableBalance: newRecipientAvailable,
        lockedBalance: recipientWallet.lockedBalance,
        expectedVersion: recipientWallet.version,
      });
      if (!updatedRecipient) {
        throw new WalletConcurrencyError(recipientId, recipientWallet.version);
      }

      const transactionId = crypto.randomUUID();
      let senderLedgerEntry, recipientLedgerEntry;

      try {
        senderLedgerEntry = await activeTx.ledger.recordEntry({
          transactionId,
          userId: senderId,
          amount: senderDelta,
          balanceAfter: newSenderAvailable,
          class: validClass,
          type: validType,
          source,
          referenceId,
          counterparty: recipientId,
          metadata,
          idempotencyKey,
          configVersion,
        });

        recipientLedgerEntry = await activeTx.ledger.recordEntry({
          transactionId,
          userId: recipientId,
          amount: recipientDelta,
          balanceAfter: newRecipientAvailable,
          class: validClass,
          type: validType,
          source,
          referenceId,
          counterparty: senderId,
          metadata,
          idempotencyKey: null, // Idempotency key bound to primary sender
          configVersion,
        });
      } catch (err) {
        if (err.code === '23505' && (err.constraint === LEDGER_IDEMPOTENCY_UNIQUE_CONSTRAINT || err.message?.includes('uq_v2_ledger_entries_user_idempotency'))) {
          throw new DuplicateLedgerIdempotencyError(senderId, idempotencyKey);
        }
        throw err;
      }

      const transferEvent = createDomainEvent({
        eventType: EVENT_TYPES.TRANSFER_COMPLETED,
        aggregate: { type: 'wallet', id: senderId },
        payload: {
          transactionId,
          senderId,
          recipientId,
          amount: valAmount.toString(),
          senderAvailableBalance: newSenderAvailable.toString(),
          recipientAvailableBalance: newRecipientAvailable.toString(),
          type: validType,
          source,
          referenceId,
          idempotencyKey,
        },
      });
      activeTx.outbox.record(transferEvent);

      return {
        senderWallet: updatedSender,
        recipientWallet: updatedRecipient,
        transactionId,
        ledgerEntries: [senderLedgerEntry, recipientLedgerEntry],
      };
    });
  }

  /**
   * Holds / Escrow Lifecycle: 1. CREATE HOLD (CREATED state)
   */
  async createHold({ userId, amount, purpose, reference = null, metadata = {} }, tx = null) {
    if (!userId || typeof userId !== 'string') {
      throw new Error('Valid userId required to create hold.');
    }

    const valAmount = validateIntegerDong(amount);
    const validPurpose = validateHoldPurpose(purpose);

    return await this._withTx(tx, async (activeTx) => {
      let wallet = await activeTx.wallets.getByUserId(userId);
      if (!wallet) {
        wallet = await activeTx.wallets.create({ userId });
      }

      const hold = await activeTx.holds.create({
        userId,
        amount: valAmount,
        purpose: validPurpose,
        reference,
        status: HOLD_STATUSES.CREATED,
        metadata,
      });

      const event = createDomainEvent({
        eventType: EVENT_TYPES.HOLD_CREATED,
        aggregate: { type: 'hold', id: hold.holdId },
        payload: {
          holdId: hold.holdId,
          userId,
          amount: valAmount.toString(),
          purpose: validPurpose,
          status: HOLD_STATUSES.CREATED,
          reference,
        },
      });
      activeTx.outbox.record(event);

      return hold;
    });
  }

  /**
   * Holds / Escrow Lifecycle: 2. ACTIVATE HOLD (CREATED -> ACTIVE)
   * Moves spendable value from available_balance to locked_balance exactly once.
   */
  async activateHold({ holdId, userId }, tx = null) {
    if (!holdId || typeof holdId !== 'string') {
      throw new Error('Valid holdId required to activate hold.');
    }

    return await this._withTx(tx, async (activeTx) => {
      const hold = await activeTx.holds.getById(holdId);
      if (!hold) {
        throw new HoldNotFoundError(holdId);
      }
      if (userId && hold.userId !== userId) {
        throw new Error(`Hold "${holdId}" belongs to user "${hold.userId}", not "${userId}".`);
      }
      if (hold.status !== HOLD_STATUSES.CREATED) {
        throw new InvalidHoldStatusError(holdId, hold.status, HOLD_STATUSES.ACTIVE, 'activate hold');
      }

      const wallet = await activeTx.wallets.getByUserId(hold.userId);
      if (!wallet) {
        throw new WalletNotFoundError(hold.userId);
      }

      const currentAvailable = BigInt(wallet.availableBalance);
      const currentLocked = BigInt(wallet.lockedBalance);
      const holdAmount = BigInt(hold.amount);

      if (currentAvailable < holdAmount) {
        throw new InsufficientBalanceError(hold.userId, holdAmount.toString(), currentAvailable.toString());
      }

      const newAvailable = currentAvailable - holdAmount;
      const newLocked = currentLocked + holdAmount;

      const updatedWallet = await activeTx.wallets.updateBalanceWithOptimisticLock(hold.userId, {
        availableBalance: newAvailable,
        lockedBalance: newLocked,
        expectedVersion: wallet.version,
      });

      if (!updatedWallet) {
        throw new WalletConcurrencyError(hold.userId, wallet.version);
      }

      const updatedHold = await activeTx.holds.updateStatus(holdId, {
        expectedStatus: HOLD_STATUSES.CREATED,
        newStatus: HOLD_STATUSES.ACTIVE,
      });

      if (!updatedHold) {
        throw new InvalidHoldStatusError(holdId, hold.status, HOLD_STATUSES.ACTIVE, 'activate hold');
      }

      const transactionId = crypto.randomUUID();
      const ledgerEntry = await activeTx.ledger.recordEntry({
        transactionId,
        userId: hold.userId,
        amount: -holdAmount,
        balanceAfter: newAvailable,
        class: 'SPECIAL',
        type: 'hold.activate',
        source: 'escrow',
        referenceId: holdId,
        counterparty: null,
        metadata: { holdId, purpose: hold.purpose },
        idempotencyKey: null,
        configVersion: null,
      });

      const event = createDomainEvent({
        eventType: EVENT_TYPES.HOLD_ACTIVATED,
        aggregate: { type: 'hold', id: holdId },
        payload: {
          holdId,
          userId: hold.userId,
          amount: holdAmount.toString(),
          purpose: hold.purpose,
          status: HOLD_STATUSES.ACTIVE,
          availableBalance: newAvailable.toString(),
          lockedBalance: newLocked.toString(),
        },
      });
      activeTx.outbox.record(event);

      return { hold: updatedHold, wallet: updatedWallet, ledgerEntry };
    });
  }

  /**
   * Holds / Escrow Lifecycle: 3a. RELEASE HOLD (ACTIVE -> RELEASED)
   * Restores locked value back to available_balance.
   */
  async releaseHold({ holdId, userId, metadata = {} }, tx = null) {
    if (!holdId || typeof holdId !== 'string') {
      throw new Error('Valid holdId required to release hold.');
    }

    return await this._withTx(tx, async (activeTx) => {
      const hold = await activeTx.holds.getById(holdId);
      if (!hold) {
        throw new HoldNotFoundError(holdId);
      }
      if (userId && hold.userId !== userId) {
        throw new Error(`Hold "${holdId}" belongs to user "${hold.userId}", not "${userId}".`);
      }
      if (hold.status !== HOLD_STATUSES.ACTIVE) {
        throw new InvalidHoldStatusError(holdId, hold.status, HOLD_STATUSES.RELEASED, 'release hold');
      }

      const wallet = await activeTx.wallets.getByUserId(hold.userId);
      if (!wallet) {
        throw new WalletNotFoundError(hold.userId);
      }

      const currentAvailable = BigInt(wallet.availableBalance);
      const currentLocked = BigInt(wallet.lockedBalance);
      const holdAmount = BigInt(hold.amount);

      if (currentLocked < holdAmount) {
        throw new Error(`Inconsistent wallet locked balance for hold release on user "${hold.userId}".`);
      }

      const newLocked = currentLocked - holdAmount;
      const newAvailable = currentAvailable + holdAmount;

      const updatedWallet = await activeTx.wallets.updateBalanceWithOptimisticLock(hold.userId, {
        availableBalance: newAvailable,
        lockedBalance: newLocked,
        expectedVersion: wallet.version,
      });

      if (!updatedWallet) {
        throw new WalletConcurrencyError(hold.userId, wallet.version);
      }

      const updatedHold = await activeTx.holds.updateStatus(holdId, {
        expectedStatus: HOLD_STATUSES.ACTIVE,
        newStatus: HOLD_STATUSES.RELEASED,
        metadata,
      });

      if (!updatedHold) {
        throw new InvalidHoldStatusError(holdId, hold.status, HOLD_STATUSES.RELEASED, 'release hold');
      }

      const transactionId = crypto.randomUUID();
      const ledgerEntry = await activeTx.ledger.recordEntry({
        transactionId,
        userId: hold.userId,
        amount: +holdAmount,
        balanceAfter: newAvailable,
        class: 'SPECIAL',
        type: 'hold.release',
        source: 'escrow',
        referenceId: holdId,
        counterparty: null,
        metadata: { holdId, purpose: hold.purpose, ...metadata },
        idempotencyKey: null,
        configVersion: null,
      });

      const event = createDomainEvent({
        eventType: EVENT_TYPES.HOLD_RELEASED,
        aggregate: { type: 'hold', id: holdId },
        payload: {
          holdId,
          userId: hold.userId,
          amount: holdAmount.toString(),
          purpose: hold.purpose,
          status: HOLD_STATUSES.RELEASED,
          availableBalance: newAvailable.toString(),
          lockedBalance: newLocked.toString(),
        },
      });
      activeTx.outbox.record(event);

      return { hold: updatedHold, wallet: updatedWallet, ledgerEntry };
    });
  }

  /**
   * Holds / Escrow Lifecycle: 3b. CAPTURE HOLD (ACTIVE -> CAPTURED)
   * Deducts locked value and optionally credits counterparty recipient.
   */
  async captureHold({ holdId, userId, targetUserId = null, metadata = {} }, tx = null) {
    if (!holdId || typeof holdId !== 'string') {
      throw new Error('Valid holdId required to capture hold.');
    }

    return await this._withTx(tx, async (activeTx) => {
      const hold = await activeTx.holds.getById(holdId);
      if (!hold) {
        throw new HoldNotFoundError(holdId);
      }
      if (userId && hold.userId !== userId) {
        throw new Error(`Hold "${holdId}" belongs to user "${hold.userId}", not "${userId}".`);
      }
      if (hold.status !== HOLD_STATUSES.ACTIVE) {
        throw new InvalidHoldStatusError(holdId, hold.status, HOLD_STATUSES.CAPTURED, 'capture hold');
      }

      const userWallet = await activeTx.wallets.getByUserId(hold.userId);
      if (!userWallet) {
        throw new WalletNotFoundError(hold.userId);
      }

      const userAvailable = BigInt(userWallet.availableBalance);
      const userLocked = BigInt(userWallet.lockedBalance);
      const holdAmount = BigInt(hold.amount);

      if (userLocked < holdAmount) {
        throw new Error(`Inconsistent wallet locked balance for hold capture on user "${hold.userId}".`);
      }

      const newUserLocked = userLocked - holdAmount;
      const updatedUserWallet = await activeTx.wallets.updateBalanceWithOptimisticLock(hold.userId, {
        availableBalance: userAvailable,
        lockedBalance: newUserLocked,
        expectedVersion: userWallet.version,
      });

      if (!updatedUserWallet) {
        throw new WalletConcurrencyError(hold.userId, userWallet.version);
      }

      let updatedTargetWallet = null;
      let targetLedgerEntry = null;

      if (targetUserId) {
        let targetWallet = await activeTx.wallets.getByUserId(targetUserId);
        if (!targetWallet) {
          targetWallet = await activeTx.wallets.create({ userId: targetUserId });
        }
        const targetAvailable = BigInt(targetWallet.availableBalance);
        const newTargetAvailable = targetAvailable + holdAmount;

        updatedTargetWallet = await activeTx.wallets.updateBalanceWithOptimisticLock(targetUserId, {
          availableBalance: newTargetAvailable,
          lockedBalance: targetWallet.lockedBalance,
          expectedVersion: targetWallet.version,
        });

        if (!updatedTargetWallet) {
          throw new WalletConcurrencyError(targetUserId, targetWallet.version);
        }
      }

      const updatedHold = await activeTx.holds.updateStatus(holdId, {
        expectedStatus: HOLD_STATUSES.ACTIVE,
        newStatus: HOLD_STATUSES.CAPTURED,
        metadata,
      });

      if (!updatedHold) {
        throw new InvalidHoldStatusError(holdId, hold.status, HOLD_STATUSES.CAPTURED, 'capture hold');
      }

      const transactionId = crypto.randomUUID();

      const userLedgerEntry = await activeTx.ledger.recordEntry({
        transactionId,
        userId: hold.userId,
        amount: -holdAmount,
        balanceAfter: userAvailable,
        class: 'SPECIAL',
        type: 'hold.capture',
        source: 'escrow',
        referenceId: holdId,
        counterparty: targetUserId,
        metadata: { holdId, purpose: hold.purpose, targetUserId, ...metadata },
        idempotencyKey: null,
        configVersion: null,
      });

      if (targetUserId && updatedTargetWallet) {
        targetLedgerEntry = await activeTx.ledger.recordEntry({
          transactionId,
          userId: targetUserId,
          amount: +holdAmount,
          balanceAfter: BigInt(updatedTargetWallet.availableBalance),
          class: 'SPECIAL',
          type: 'hold.capture',
          source: 'escrow',
          referenceId: holdId,
          counterparty: hold.userId,
          metadata: { holdId, purpose: hold.purpose, sourceUserId: hold.userId, ...metadata },
          idempotencyKey: null,
          configVersion: null,
        });
      }

      const event = createDomainEvent({
        eventType: EVENT_TYPES.HOLD_CAPTURED,
        aggregate: { type: 'hold', id: holdId },
        payload: {
          holdId,
          userId: hold.userId,
          targetUserId,
          amount: holdAmount.toString(),
          purpose: hold.purpose,
          status: HOLD_STATUSES.CAPTURED,
        },
      });
      activeTx.outbox.record(event);

      return {
        hold: updatedHold,
        wallet: updatedUserWallet,
        targetWallet: updatedTargetWallet,
        ledgerEntries: targetLedgerEntry ? [userLedgerEntry, targetLedgerEntry] : [userLedgerEntry],
      };
    });
  }
}
