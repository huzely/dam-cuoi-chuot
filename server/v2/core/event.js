/**
 * Domain Event primitive for V2 Server Foundation.
 * Domain events describe facts that have already occurred.
 */

/**
 * Creates and validates a domain event object.
 *
 * @param {Object} params
 * @param {string} [params.eventId] - Unique event ID
 * @param {string} params.eventType - Event type in past tense (e.g., 'festival.booth_entered')
 * @param {Object} params.aggregate - Aggregate reference { type, id }
 * @param {Object} [params.actor] - Actor reference { actorId }
 * @param {string} [params.occurredAt] - ISO timestamp
 * @param {string} [params.schemaVersion] - Schema version
 * @param {Object} [params.payload={}] - Event details
 */
export function createDomainEvent({
  eventId = `evt_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`,
  eventType,
  aggregate,
  actor = null,
  occurredAt = new Date().toISOString(),
  schemaVersion = '1.0.0',
  payload = {},
}) {
  if (!eventType || typeof eventType !== 'string') {
    throw new Error('Domain eventType is required.');
  }

  if (!aggregate || typeof aggregate !== 'object' || !aggregate.type || !aggregate.id) {
    throw new Error('Domain event requires aggregate reference with type and id.');
  }

  return Object.freeze({
    eventId,
    eventType,
    aggregate: Object.freeze({ type: aggregate.type, id: String(aggregate.id) }),
    actor: actor ? Object.freeze({ actorId: actor.actorId }) : null,
    occurredAt,
    schemaVersion,
    payload: Object.freeze({ ...payload }),
  });
}
