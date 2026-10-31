/**
 * V2 Social Domain Contract Boundary
 */
import { FEATURE_FLAGS } from '../../core/feature-flags.js';

export const DOMAIN_NAME = 'social';

export const COMMAND_TYPES = Object.freeze({
  SEND_GIFT: 'social.send_gift',
});

export const EVENT_TYPES = Object.freeze({
  GIFT_SENT: 'social.gift_sent',
});

export const REQUIRED_FEATURE_FLAGS = Object.freeze([
  FEATURE_FLAGS.GIFTS_V2,
]);

export function getDomainMetadata() {
  return {
    domain: DOMAIN_NAME,
    commandTypes: Object.values(COMMAND_TYPES),
    eventTypes: Object.values(EVENT_TYPES),
    requiredFlags: [...REQUIRED_FEATURE_FLAGS],
  };
}
