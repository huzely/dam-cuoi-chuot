/**
 * Abstract Outbox Event Recorder Primitive for V2.
 * Collects domain events during a Unit of Work and flushes them upon transaction commit.
 */

export class OutboxRecorder {
  constructor() {
    this.pendingEvents = [];
    this.committedEvents = [];
  }

  /**
   * Adds a domain event to the pending outbox.
   * @param {Object} domainEvent
   */
  record(domainEvent) {
    if (!domainEvent || !domainEvent.eventId) {
      throw new Error('Valid domain event required for outbox recording.');
    }
    this.pendingEvents.push(domainEvent);
  }

  /**
   * Flushes pending events to committed outbox state.
   */
  async flush() {
    this.committedEvents.push(...this.pendingEvents);
    this.pendingEvents = [];
  }

  /**
   * Clears pending events (e.g. on transaction rollback).
   */
  clearPending() {
    this.pendingEvents = [];
  }

  /**
   * Retrieves all committed outbox events.
   */
  getCommittedEvents() {
    return [...this.committedEvents];
  }
}
