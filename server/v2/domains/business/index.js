/**
 * V2 Business Domain Contract Boundary
 */
import { FEATURE_FLAGS } from '../../core/feature-flags.js';

export const DOMAIN_NAME = 'business';

export const COMMAND_TYPES = Object.freeze({
  REGISTER_STALL: 'business.register_stall',
});

export const EVENT_TYPES = Object.freeze({
  STALL_REGISTERED: 'business.stall_registered',
});

export const REQUIRED_FEATURE_FLAGS = Object.freeze([
  FEATURE_FLAGS.TAX_V2,
]);

export function getDomainMetadata() {
  return {
    domain: DOMAIN_NAME,
    commandTypes: Object.values(COMMAND_TYPES),
    eventTypes: Object.values(EVENT_TYPES),
    requiredFlags: [...REQUIRED_FEATURE_FLAGS],
  };
}
