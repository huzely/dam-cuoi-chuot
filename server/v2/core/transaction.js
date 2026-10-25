/**
 * Abstract Transaction & Unit of Work Primitive for V2.
 * Defines contractual interface for atomic database transaction boundaries.
 */

export class TransactionContext {
  constructor() {
    this.active = false;
    this.committed = false;
    this.rolledBack = false;
    this.mutations = [];
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
  }
}

/**
 * UnitOfWork manages the transaction context and outbox event collector.
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
      await this.tx.commit();
      await this.outbox.flush();
      return result;
    } catch (err) {
      await this.tx.rollback();
      this.outbox.clearPending();
      throw err;
    }
  }
}
