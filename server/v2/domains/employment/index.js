/**
 * V2 Employment Domain Contract Boundary
 */
import { FEATURE_FLAGS } from '../../core/feature-flags.js';

export const DOMAIN_NAME = 'employment';

export const COMMAND_TYPES = Object.freeze({
  ACCEPT_JOB: 'employment.accept_job',
});

export const EVENT_TYPES = Object.freeze({
  JOB_ACCEPTED: 'employment.job_accepted',
});

export const REQUIRED_FEATURE_FLAGS = Object.freeze([
  FEATURE_FLAGS.EMPLOYMENT_V2,
]);

export function getDomainMetadata() {
  return {
    domain: DOMAIN_NAME,
    commandTypes: Object.values(COMMAND_TYPES),
    eventTypes: Object.values(EVENT_TYPES),
    requiredFlags: [...REQUIRED_FEATURE_FLAGS],
  };
}
