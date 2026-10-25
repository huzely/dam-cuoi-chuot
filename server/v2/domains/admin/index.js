/**
 * V2 Admin / Operations Domain Contract Boundary
 */
import { FEATURE_FLAGS } from '../../core/feature-flags.js';

export const DOMAIN_NAME = 'admin';

export const COMMAND_TYPES = Object.freeze({
  EXECUTE_ADMIN_ACTION: 'admin.execute_action',
});

export const EVENT_TYPES = Object.freeze({
  ADMIN_AUDIT_LOGGED: 'admin.audit_logged',
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
