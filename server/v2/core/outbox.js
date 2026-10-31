/**
 * Abstract Outbox Event Recorder & Publisher Primitives for V2.
 *
 * Contract:
 * 1. Outbox events are collected during domain execution and persisted INSIDE the DB transaction.
 * 2. Once the DB transaction commits, outbox events transition to 'COMMITTED_IN_STORAGE'.
 * 3. Post-commit publication/delivery happens asynchronously after commit.
 * 4. Publication failure AFTER commit DOES NOT roll back committed state/outbox events.
 *    The outbox record remains committed in storage for retryable publication.
 */

export class OutboxRecorder {
  constructor() {
    this.pendingEvents = [];
    this.committedEvents = [];
  }

  /**
   * Records a domain event to be persisted inside the transaction.
   * @param {Object} domainEvent
   */
  record(domainEvent) {
    if (!domainEvent || !domainEvent.eventId) {
      throw new Error('Valid domain event required for outbox recording.');
    }
    this.pendingEvents.push(domainEvent);
  }

  getPendingEvents() {
    return [...this.pendingEvents];
  }

  /**
   * Called by UnitOfWork upon successful atomic DB transaction commit.
   * @param {Array<Object>} stagedEvents
   */
  onTransactionCommitted(stagedEvents) {
    for (const evt of stagedEvents) {
      this.committedEvents.push({
        event: evt,
        status: 'COMMITTED_IN_STORAGE', // Persisted in DB, pending delivery/publication
        publishedAt: null,
      });
    }
    this.pendingEvents = [];
  }

  /**
   * Clears pending events on transaction rollback.
   */
  clearPending() {
    this.pendingEvents = [];
  }

  getCommittedOutboxRecords() {
    return [...this.committedEvents];
  }
}

/**
 * Post-commit Outbox Publisher Primitive.
 */
export class OutboxPublisher {
  /**
   * Accepts (dbClient, publishFn) or (publishFn).
   */
  constructor(dbClientOrPublishFn, publishFn) {
    if (typeof dbClientOrPublishFn === 'function') {
      this.db = null;
      this.publishFn = dbClientOrPublishFn;
    } else {
      this.db = dbClientOrPublishFn || null;
      this.publishFn = typeof publishFn === 'function' ? publishFn : async () => {};
    }
  }

  /**
   * Attempts post-commit publication for committed outbox records.
   * Publication failure does NOT roll back committed DB state.
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

        if (this.db && typeof this.db.updateOutboxRecordStatus === 'function') {
          await this.db.updateOutboxRecordStatus(eventId, {
            status: 'PUBLISHED',
            publishedAt,
          });
        }

        record.status = 'PUBLISHED';
        record.publishedAt = publishedAt;
        publishedEvents.push(record.event);
      } catch (err) {
        const attemptCount = (record.attemptCount || 0) + 1;
        const lastError = err.message;

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
}
