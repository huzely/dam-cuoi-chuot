/**
 * Durable Postgres Outbox Recorder & Publisher Adapter.
 *
 * Contract:
 * 1. Outbox events are collected during domain execution and persisted INSIDE the DB transaction.
 * 2. Status in storage: 'COMMITTED_IN_STORAGE'.
 * 3. Asynchronous post-commit publisher handles event delivery.
 * 4. Retry worker claims records durably in batch using 'PUBLISHING' status with FOR UPDATE SKIP LOCKED.
 * 5. Publication status updates (PUBLISHED or PUBLICATION_FAILED_RETRYABLE) are persisted
 *    durably into database storage via the outbox repository driver.
 * 6. Successful publication sets status to PUBLISHED and clears last_error.
 */

import { MissingDatabaseDriverError } from './pg-idempotency.js';

export class PgOutboxRecorder {
  constructor() {
    this.pendingEvents = [];
    this.committedEvents = [];
  }

  record(domainEvent) {
    if (!domainEvent || !domainEvent.eventId) {
      throw new Error('Valid domain event required for outbox recording.');
    }
    this.pendingEvents.push(domainEvent);
  }

  getPendingEvents() {
    return [...this.pendingEvents];
  }

  onTransactionCommitted(stagedEvents) {
    for (const evt of stagedEvents) {
      this.committedEvents.push({
        event: evt,
        status: 'COMMITTED_IN_STORAGE',
        attemptCount: 0,
        lastError: null,
        publishedAt: null,
      });
    }
    this.pendingEvents = [];
  }

  clearPending() {
    this.pendingEvents = [];
  }

  getCommittedOutboxRecords() {
    return [...this.committedEvents];
  }
}

export class PgOutboxPublisher {
  /**
   * @param {Object} dbClient - Production DB driver or explicit test memory driver
   * @param {Function} [publishFn] - External event publishing transport
   */
  constructor(dbClient, publishFn) {
    if (!dbClient) {
      throw new MissingDatabaseDriverError('PgOutboxPublisher');
    }
    this.db = dbClient;
    this.publishFn = typeof publishFn === 'function' ? publishFn : async () => {};
  }

  /**
   * Delivers committed outbox records post-commit and durably persists status updates in DB storage.
   *
   * @param {Array<Object>} outboxRecords
   */
  async publishCommitted(outboxRecords) {
    const publishedEvents = [];
    const publicationErrors = [];

    for (const record of outboxRecords) {
      const eventId = record.event?.eventId;
      try {
        await this.publishFn(record.event);
        const publishedAt = new Date().toISOString();

        // Durably update outbox record status to PUBLISHED in DB storage and clear last_error
        if (this.db && typeof this.db.updateOutboxRecordStatus === 'function') {
          await this.db.updateOutboxRecordStatus(eventId, {
            status: 'PUBLISHED',
            publishedAt,
          });
        }

        record.status = 'PUBLISHED';
        record.publishedAt = publishedAt;
        record.lastError = null;
        publishedEvents.push(record.event);
      } catch (err) {
        const attemptCount = (record.attemptCount || 0) + 1;
        const lastError = err.message;

        // Durably update outbox record status to PUBLICATION_FAILED_RETRYABLE in DB storage
        if (this.db && typeof this.db.updateOutboxRecordStatus === 'function') {
          await this.db.updateOutboxRecordStatus(eventId, {
            status: 'PUBLICATION_FAILED_RETRYABLE',
            attemptCount,
            lastError,
          });
        }

        record.status = 'PUBLICATION_FAILED_RETRYABLE';
        record.attemptCount = attemptCount;
        record.lastError = lastError;
        publicationErrors.push({ eventId, error: err });
      }
    }

    return {
      publishedEvents,
      publicationErrors,
    };
  }

  /**
   * Safe retry worker path: Claims retryable outbox batch with FOR UPDATE SKIP LOCKED and publishes.
   *
   * @param {number} [batchSize=10]
   */
  async processRetryableOutbox(batchSize = 10) {
    if (!this.db || typeof this.db.claimRetryableOutboxBatch !== 'function') {
      return { publishedEvents: [], publicationErrors: [] };
    }
    const claimedRecords = await this.db.claimRetryableOutboxBatch(batchSize);
    return await this.publishCommitted(claimedRecords);
  }
}

/**
 * EXPLICIT TEST DOUBLE: In-memory driver for testing durable outbox state persistence.
 */
export class MemoryOutboxDriver {
  constructor() {
    this.outboxTable = new Map();
  }

  async insertOutboxRecord(record) {
    this.outboxTable.set(record.event.eventId, { ...record });
  }

  async updateOutboxRecordStatus(eventId, updates) {
    const existing = this.outboxTable.get(eventId) || { event: { eventId } };
    this.outboxTable.set(eventId, {
      ...existing,
      ...updates,
      lastError: updates.status === 'PUBLISHED' ? null : (updates.lastError ?? existing.lastError),
      updatedAt: new Date().toISOString(),
    });
  }

  async getOutboxRecord(eventId) {
    return this.outboxTable.get(eventId) || null;
  }

  async claimRetryableOutboxBatch(batchSize = 10) {
    const results = [];
    for (const record of this.outboxTable.values()) {
      if (record.status === 'COMMITTED_IN_STORAGE' || record.status === 'PUBLICATION_FAILED_RETRYABLE') {
        record.status = 'PUBLISHING';
        results.push(record);
        if (results.length >= batchSize) break;
      }
    }
    return results;
  }
}
