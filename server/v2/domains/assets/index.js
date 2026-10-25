/**
 * V2 Assets Domain Contract Boundary
 */
import { FEATURE_FLAGS } from '../../core/feature-flags.js';

export const DOMAIN_NAME = 'assets';

export const COMMAND_TYPES = Object.freeze({
  REGISTER_ITEM: 'assets.register_item',
});

export const EVENT_TYPES = Object.freeze({
  ITEM_REGISTERED: 'assets.item_registered',
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
