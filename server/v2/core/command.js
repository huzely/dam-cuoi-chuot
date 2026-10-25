/**
 * Semantic Command primitive for V2 Server Foundation.
 */

const FORBIDDEN_GENERIC_COMMANDS = new Set([
  'money.add',
  'wallet.update',
  'inventory.set',
  'profile.setRank',
]);

/**
 * Creates and validates a semantic V2 command.
 *
 * @param {Object} params
 * @param {string} params.type - Domain command type (e.g., 'festival.enter_booth')
 * @param {Object} params.actor - Trusted authenticated actor supplied by trusted server auth context
 * @param {string} params.actor.actorId - Authenticated user ID from trusted auth context
 * @param {string} [params.actor.role] - Authenticated role (e.g. 'PLAYER', 'ADMIN')
 * @param {string} [params.commandId] - Unique command/request ID
 * @param {string} [params.idempotencyKey] - Optional idempotency key
 * @param {Object} [params.payload={}] - Command payload parameters
 * @param {string} [params.rulesetVersion] - Config/ruleset version snapshot
 * @param {string|number} [params.timestamp] - Command issuance timestamp
 */
export function createCommand({
  type,
  actor,
  commandId = `cmd_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`,
  idempotencyKey = null,
  payload = {},
  rulesetVersion = '1.0.0',
  timestamp = new Date().toISOString(),
}) {
  if (!type || typeof type !== 'string') {
    throw new Error('Command type is required and must be a string.');
  }

  if (FORBIDDEN_GENERIC_COMMANDS.has(type)) {
    throw new Error(`Forbidden generic command type: "${type}". Future APIs must express semantic actions.`);
  }

  if (!actor || typeof actor !== 'object' || !actor.actorId) {
    throw new Error('Authenticated actor with a valid actorId supplied by trusted server context is required.');
  }

  // Security hardening: Command payloads must not specify actor keys (userId or actorId).
  // Explicit target names such as targetUserId or recipientUserId must be used when semantically needed.
  if (payload && (Object.prototype.hasOwnProperty.call(payload, 'userId') || Object.prototype.hasOwnProperty.call(payload, 'actorId'))) {
    throw new Error('Security Error: Command payload must not specify userId or actorId. Use explicit domain names like targetUserId or recipientUserId.');
  }

  return Object.freeze({
    commandId,
    type,
    actor: Object.freeze({
      actorId: actor.actorId,
      role: actor.role || 'PLAYER',
      authenticatedAt: actor.authenticatedAt || timestamp,
    }),
    idempotencyKey,
    payload: Object.freeze({ ...payload }),
    rulesetVersion,
    timestamp,
  });
}
