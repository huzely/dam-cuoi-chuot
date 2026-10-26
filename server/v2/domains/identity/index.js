/**
 * V2 Identity Domain Contract Boundary
 */
import { FEATURE_FLAGS } from '../../core/feature-flags.js';
import { AccountNotFoundError } from './errors.js';
import { AccountService } from './service.js';

export const DOMAIN_NAME = 'identity';

export const ACCOUNT_STATES = Object.freeze({
  ACTIVE: 'ACTIVE',
  SUSPENDED: 'SUSPENDED',
  DISABLED: 'DISABLED',
});

export const COMMAND_TYPES = Object.freeze({
  CREATE_ACCOUNT: 'identity.create_account',
  AUTHENTICATE_SESSION: 'identity.authenticate_session',
});

export const EVENT_TYPES = Object.freeze({
  ACCOUNT_CREATED: 'identity.account_created',
  SESSION_AUTHENTICATED: 'identity.session_authenticated',
});

export const REQUIRED_FEATURE_FLAGS = Object.freeze([
  FEATURE_FLAGS.ACCOUNT_V2,
]);

export function getDomainMetadata() {
  return {
    domain: DOMAIN_NAME,
    accountStates: Object.values(ACCOUNT_STATES),
    commandTypes: Object.values(COMMAND_TYPES),
    eventTypes: Object.values(EVENT_TYPES),
    requiredFlags: [...REQUIRED_FEATURE_FLAGS],
  };
}

export {
  AccountService,
  AccountNotFoundError,
};
