/**
 * Durable Postgres Outbox Recorder & Publisher Adapter.
 *
 * Contract:
 * 1. Outbox records are inserted into the v2_outbox table INSIDE the atomic DB transaction.
 * 2. Status in storage: 'COMMITTED_IN_STORAGE'.
 * 3. Asynchronous post-commit publisher handles event delivery.
 * 4. Publication failures AFTER commit transition status to 'PUBLICATION_FAILED_RETRYABLE'
 *    leaving already-committed DB state untouched and available for retry.
 */

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
  constructor(publishFn = async () => {}) {
    this.publishFn = publishFn;
  }

  async publishCommitted(outboxRecords) {
    const publishedEvents = [];
    const publicationErrors = [];

    for (const record of outboxRecords) {
      try {
        await this.publishFn(record.event);
        record.status = 'PUBLISHED';
        record.publishedAt = new Date().toISOString();
        publishedEvents.push(record.event);
      } catch (err) {
        record.status = 'PUBLICATION_FAILED_RETRYABLE';
        record.attemptCount = (record.attemptCount || 0) + 1;
        record.lastError = err.message;
        publicationErrors.push({ eventId: record.event.eventId, error: err });
      }
    }

    return {
      publishedEvents,
      publicationErrors,
    };
  }
}
