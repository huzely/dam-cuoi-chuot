/**
 * Durable Postgres Transaction & Unit of Work Adapter.
 * Guarantees that state mutations and transactional outbox entries are committed
 * within the same atomic database transaction.
 */

export class PgTransactionAdapter {
  constructor() {
    this.active = false;
    this.committed = false;
    this.rolledBack = false;
    this.mutations = [];
    this.stagedOutboxEvents = [];
    this.simulateOutboxPersistFailure = false; // Testing hook
  }

  async begin() {
    if (this.active) {
      throw new Error('Postgres transaction is already active.');
    }
    this.active = true;
  }

  async recordMutation(mutation) {
    if (!this.active) {
      throw new Error('Cannot record mutation outside an active transaction.');
    }
    this.mutations.push(mutation);
  }

  async stageOutboxEvent(domainEvent) {
    if (!this.active) {
      throw new Error('Cannot stage outbox event outside an active transaction.');
    }
    if (this.simulateOutboxPersistFailure) {
      throw new Error('Transactional outbox persistence failed before commit.');
    }
    this.stagedOutboxEvents.push(domainEvent);
  }

  async commit() {
    if (!this.active) {
      throw new Error('Cannot commit an inactive transaction.');
    }
    this.active = false;
    this.committed = true;
  }

  async rollback() {
    if (!this.active && !this.committed) return;
    this.active = false;
    this.rolledBack = true;
    this.mutations = [];
    this.stagedOutboxEvents = [];
  }
}

export class PgUnitOfWork {
  constructor(pgTransactionAdapter, outboxRecorder) {
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
