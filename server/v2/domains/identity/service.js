/**
 * V2 Account Domain Service.
 * Manages authoritative V2 accounts, immutable user_ids, and account domain events.
 */

import { MissingDatabaseDriverError } from '../../adapters/pg-idempotency.js';
import { createDomainEvent } from '../../core/event.js';
import {
  ACCOUNT_STATES,
  EVENT_TYPES,
  AccountNotFoundError,
} from './index.js';

export class AccountService {
  /**
   * @param {Object} params
   * @param {Object} params.pgDriver - PostgreSQL Driver adapter (REQUIRED)
   */
  constructor({ pgDriver }) {
    if (!pgDriver) {
      throw new MissingDatabaseDriverError('AccountService');
    }
    this.pgDriver = pgDriver;
  }

  /**
   * Creates a new V2 account with an immutable UUID user_id.
   *
   * @param {Object} [params]
   * @param {string} [params.state='ACTIVE'] - Initial account state
   * @param {Object} [tx] - Optional active transaction handle
   * @returns {Promise<Object>} Account record
   */
  async createAccount(params = {}, tx = null) {
    const state = params.state || ACCOUNT_STATES.ACTIVE;
    if (!Object.values(ACCOUNT_STATES).includes(state)) {
      throw new Error(`Invalid account state "${state}". Allowed states: ACTIVE, SUSPENDED, DISABLED.`);
    }

    const execute = async (activeTx) => {
      const account = await activeTx.accounts.create({ state });

      // Record outbox domain event atomically within transaction
      const event = createDomainEvent({
        eventType: EVENT_TYPES.ACCOUNT_CREATED,
        aggregate: { type: 'account', id: account.userId },
        payload: {
          userId: account.userId,
          state: account.state,
          createdAt: account.createdAt,
        },
      });
      activeTx.outbox.record(event);

      return account;
    };

    if (tx) {
      return await execute(tx);
    }
    return await this.pgDriver.withTransaction(execute);
  }

  /**
   * Retrieves a V2 account by its immutable user_id.
   *
   * @param {string} userId - UUID string
   * @param {Object} [tx] - Optional active transaction handle
   * @returns {Promise<Object|null>} Account record or null
   */
  async getAccountById(userId, tx = null) {
    if (!userId || typeof userId !== 'string') {
      return null;
    }

    const execute = async (activeTx) => {
      return await activeTx.accounts.getById(userId);
    };

    if (tx) {
      return await execute(tx);
    }
    return await this.pgDriver.withTransaction(execute);
  }
}
