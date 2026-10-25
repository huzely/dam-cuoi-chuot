/**
 * V2 Progress Domain Contract Boundary
 */
import { FEATURE_FLAGS } from '../../core/feature-flags.js';

export const DOMAIN_NAME = 'progress';

export const COMMAND_TYPES = Object.freeze({
  RECORD_CHAPTER_COMPLETION: 'progress.record_chapter_completion',
});

export const EVENT_TYPES = Object.freeze({
  CHAPTER_COMPLETED: 'progress.chapter_completed',
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
