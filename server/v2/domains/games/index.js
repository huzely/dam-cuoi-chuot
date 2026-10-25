/**
 * V2 Games Domain Contract Boundary
 */
import { FEATURE_FLAGS } from '../../core/feature-flags.js';

export const DOMAIN_NAME = 'games';

export const COMMAND_TYPES = Object.freeze({
  INITIATE_MATCH: 'games.initiate_match',
});

export const EVENT_TYPES = Object.freeze({
  MATCH_INITIATED: 'games.match_initiated',
  MATCH_FINISHED: 'games.match_finished',
});

export const REQUIRED_FEATURE_FLAGS = Object.freeze([
  FEATURE_FLAGS.CARD_WAGER,
]);

export function getDomainMetadata() {
  return {
    domain: DOMAIN_NAME,
    commandTypes: Object.values(COMMAND_TYPES),
    eventTypes: Object.values(EVENT_TYPES),
    requiredFlags: [...REQUIRED_FEATURE_FLAGS],
  };
}
