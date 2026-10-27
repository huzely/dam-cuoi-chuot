/**
 * Semantic Command Handlers for Identity Domain.
 */
import { COMMAND_TYPES } from './index.js';

/**
 * Handles the identity.link_provider_identity semantic command.
 *
 * Rules:
 * - Must be called with a command of type 'identity.link_provider_identity'.
 * - Command actor is trusted server context (TrustedPrincipal).
 * - Payload must NOT supply userId, actorId, or direct providerSubject.
 * - Payload must supply providerAssertion.
 * - Verifies providerAssertion via providerVerifierPort.
 * - Invokes accountService.linkProviderIdentity inside active transaction.
 *
 * @param {Object} params
 * @param {Object} params.command - Semantic V2 command
 * @param {Object} params.accountService - AccountService instance
 * @param {Object} params.providerVerifier - ProviderVerifierPort instance
 * @param {Object} [params.tx] - Active transaction handle
 * @returns {Promise<Object>} Linked provider identity record
 */
export async function handleLinkProviderIdentityCommand({
  command,
  accountService,
  providerVerifier,
  tx = null,
}) {
  if (!command || command.type !== COMMAND_TYPES.LINK_PROVIDER_IDENTITY) {
    throw new Error(`Invalid command type. Expected "${COMMAND_TYPES.LINK_PROVIDER_IDENTITY}".`);
  }

  const actorId = command.actor?.actorId;
  if (!actorId || typeof actorId !== 'string') {
    throw new Error('TrustedPrincipal actorId in server auth context is required.');
  }

  const payload = command.payload || {};

  // Security hardening: Reject untrusted client payload attempts to supply userId, actorId, or direct providerSubject
  if (
    Object.prototype.hasOwnProperty.call(payload, 'userId') ||
    Object.prototype.hasOwnProperty.call(payload, 'actorId') ||
    Object.prototype.hasOwnProperty.call(payload, 'providerSubject')
  ) {
    throw new Error('Security Error: Client command payload must not supply userId, actorId, or providerSubject directly. Supply providerAssertion instead.');
  }

  const providerAssertion = payload.providerAssertion;
  if (!providerAssertion || typeof providerAssertion !== 'object') {
    throw new Error('Command payload must contain providerAssertion object.');
  }

  if (!providerVerifier || typeof providerVerifier.verifyAssertion !== 'function') {
    throw new Error('A valid ProviderVerifierPort instance is required.');
  }

  // 1. Server-side verification of provider assertion
  const verified = await providerVerifier.verifyAssertion(providerAssertion);

  // 2. Execute link with trusted actorId and verified assertion details
  return await accountService.linkProviderIdentity(
    {
      userId: actorId,
      provider: verified.provider,
      providerSubject: verified.providerSubject,
    },
    tx
  );
}
