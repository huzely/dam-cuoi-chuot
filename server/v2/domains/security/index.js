/**
 * V2 Security Domain Contract Boundary
 */
import { FEATURE_FLAGS } from '../../core/feature-flags.js';

export const DOMAIN_NAME = 'security';

export const COMMAND_TYPES = Object.freeze({
  LOG_SECURITY_INCIDENT: 'security.log_incident',
});

export const EVENT_TYPES = Object.freeze({
  INCIDENT_LOGGED: 'security.incident_logged',
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
