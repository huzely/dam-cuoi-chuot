/**
 * Abstract Transaction & Unit of Work Primitive for V2.
 * Defines contractual interface for atomic database transaction boundaries.
 * Enforces that outbox records are persisted INSIDE the same atomic transaction as state mutations.
 */

export class TransactionContext {
  constructor() {
    this.active = false;
    this.committed = false;
    this.rolledBack = false;
    this.mutations = [];
    this.stagedOutboxEvents = [];
    this.commitHooks = [];
    this.simulateOutboxPersistFailure = false;
  }

  onCommit(fn) {
    this.commitHooks.push(fn);
  }

  async begin() {
    if (this.active) {
      throw new Error('Transaction is already active.');
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
    for (const hook of this.commitHooks) {
      await hook();
    }
  }

  async rollback() {
    if (!this.active && !this.committed) return;
    this.active = false;
    this.rolledBack = true;
    this.mutations = [];
    this.stagedOutboxEvents = [];
    this.commitHooks = [];
  }
}

/**
 * UnitOfWork manages the atomic transaction context containing state mutations + outbox persistence.
 */
export class UnitOfWork {
  constructor(transactionContext, outboxRecorder) {
    this.tx = transactionContext;
    this.outbox = outboxRecorder;
  }

  async execute(workFn) {
    await this.tx.begin();
    try {
      const result = await workFn(this.tx, this.outbox);

      // Persist staged outbox events into the active transaction boundary BEFORE commit
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
