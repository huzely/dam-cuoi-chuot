/**
 * V2 Festival Domain Contract Boundary
 */
import { FEATURE_FLAGS } from '../../core/feature-flags.js';

export const DOMAIN_NAME = 'festival';

export const COMMAND_TYPES = Object.freeze({
  ENTER_BOOTH: 'festival.enter_booth',
});

export const EVENT_TYPES = Object.freeze({
  BOOTH_ENTERED: 'festival.booth_entered',
});

export const REQUIRED_FEATURE_FLAGS = Object.freeze([
  FEATURE_FLAGS.HOI_XUAN_V2,
]);

export function getDomainMetadata() {
  return {
    domain: DOMAIN_NAME,
    commandTypes: Object.values(COMMAND_TYPES),
    eventTypes: Object.values(EVENT_TYPES),
    requiredFlags: [...REQUIRED_FEATURE_FLAGS],
  };
}
