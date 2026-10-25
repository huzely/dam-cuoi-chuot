/**
 * V2 Justice Domain Contract Boundary
 */
import { FEATURE_FLAGS } from '../../core/feature-flags.js';

export const DOMAIN_NAME = 'justice';

export const COMMAND_TYPES = Object.freeze({
  FILE_COMPLAINT: 'justice.file_complaint',
});

export const EVENT_TYPES = Object.freeze({
  COMPLAINT_FILED: 'justice.complaint_filed',
});

export const REQUIRED_FEATURE_FLAGS = Object.freeze([
  FEATURE_FLAGS.COURT_V2,
]);

export function getDomainMetadata() {
  return {
    domain: DOMAIN_NAME,
    commandTypes: Object.values(COMMAND_TYPES),
    eventTypes: Object.values(EVENT_TYPES),
    requiredFlags: [...REQUIRED_FEATURE_FLAGS],
  };
}
