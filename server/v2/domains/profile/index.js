/**
 * V2 Profile Domain Contract Boundary
 */
import { FEATURE_FLAGS } from '../../core/feature-flags.js';

export const DOMAIN_NAME = 'profile';

export const COMMAND_TYPES = Object.freeze({
  UPDATE_PREFERENCES: 'profile.update_preferences',
});

export const EVENT_TYPES = Object.freeze({
  PREFERENCES_UPDATED: 'profile.preferences_updated',
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
