/**
 * V2 Village Domain Contract Boundary
 */
import { FEATURE_FLAGS } from '../../core/feature-flags.js';

export const DOMAIN_NAME = 'village';

export const COMMAND_TYPES = Object.freeze({
  UPDATE_BUILDING_STATUS: 'village.update_building_status',
});

export const EVENT_TYPES = Object.freeze({
  BUILDING_STATUS_UPDATED: 'village.building_status_updated',
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
