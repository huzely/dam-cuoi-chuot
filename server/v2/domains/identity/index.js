/**
 * V2 Identity Domain Contract Boundary
 */
import { FEATURE_FLAGS } from '../../core/feature-flags.js';

export const DOMAIN_NAME = 'identity';

export const COMMAND_TYPES = Object.freeze({
  AUTHENTICATE_SESSION: 'identity.authenticate_session',
});

export const EVENT_TYPES = Object.freeze({
  SESSION_AUTHENTICATED: 'identity.session_authenticated',
});

export const REQUIRED_FEATURE_FLAGS = Object.freeze([
  FEATURE_FLAGS.ACCOUNT_V2,
]);

export function getDomainMetadata() {
  return {
    domain: DOMAIN_NAME,
    commandTypes: Object.values(COMMAND_TYPES),
    eventTypes: Object.values(EVENT_TYPES),
    requiredFlags: [...REQUIRED_FEATURE_FLAGS],
  };
}
