/**
 * Durable Postgres Transaction & Unit of Work Adapter.
 * Guarantees that state mutations and transactional outbox entries are committed
 * within the same atomic database transaction.
 */

import { MissingDatabaseDriverError } from './pg-idempotency.js';

export class PgTransactionAdapter {
  /**
   * @param {Object} dbClient - Production DB client or explicit test driver
   */
  constructor(dbClient) {
    if (!dbClient) {
      throw new MissingDatabaseDriverError('PgTransactionAdapter');
    }
    this.db = dbClient;
  }

  async begin() {
    await this.db.beginTransaction();
  }

  async recordMutation(mutation) {
    await this.db.recordMutation(mutation);
  }

  async stageOutboxEvent(domainEvent) {
    await this.db.stageOutboxEvent(domainEvent);
  }

  async commit() {
    await this.db.commitTransaction();
  }

  async rollback() {
    await this.db.rollbackTransaction();
  }

  get committed() {
    return this.db.committed;
  }

  get rolledBack() {
    return this.db.rolledBack;
  }

  get mutations() {
    return this.db.mutations || [];
  }

  get stagedOutboxEvents() {
    return this.db.stagedOutboxEvents || [];
  }
}

export class PgUnitOfWork {
  constructor(pgTransactionAdapter, outboxRecorder) {
    if (!pgTransactionAdapter) {
      throw new Error('PgUnitOfWork requires a valid PgTransactionAdapter.');
    }
    this.tx = pgTransactionAdapter;
    this.outbox = outboxRecorder;
  }

  async execute(workFn) {
    await this.tx.begin();
    try {
      const result = await workFn(this.tx, this.outbox);

      // Persist staged outbox records into the active Postgres transaction BEFORE commit
      for (const event of this.outbox.getPendingEvents()) {
        await this.tx.stageOutboxEvent(event);
      }

      // Single atomic commit of state mutations AND outbox records
      await this.tx.commit();

      // Notify outbox recorder that records were committed into DB storage
      this.outbox.onTransactionCommitted(this.tx.stagedOutboxEvents);

      return result;
    } catch (err) {
      await this.tx.rollback();
      this.outbox.clearPending();
      throw err;
    }
  }
}

/**
 * EXPLICIT TEST DOUBLE: Memory transaction driver simulating PostgreSQL transaction block.
 */
export class MemoryTransactionDriver {
  constructor() {
    this.active = false;
    this.committed = false;
    this.rolledBack = false;
    this.mutations = [];
    this.stagedOutboxEvents = [];
    this.simulateOutboxPersistFailure = false;
  }

  async beginTransaction() {
    if (this.active) throw new Error('Transaction active');
    this.active = true;
  }

  async recordMutation(mutation) {
    if (!this.active) throw new Error('Inactive transaction');
    this.mutations.push(mutation);
  }

  async stageOutboxEvent(domainEvent) {
    if (!this.active) throw new Error('Inactive transaction');
    if (this.simulateOutboxPersistFailure) {
      throw new Error('Transactional outbox persistence failed before commit.');
    }
    this.stagedOutboxEvents.push(domainEvent);
  }

  async commitTransaction() {
    if (!this.active) throw new Error('Inactive transaction');
    this.active = false;
    this.committed = true;
  }

  async rollbackTransaction() {
    if (!this.active && !this.committed) return;
    this.active = false;
    this.rolledBack = true;
    this.mutations = [];
    this.stagedOutboxEvents = [];
  }
}
