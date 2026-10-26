/**
 * V2 Identity Domain Contract Boundary
 */
import { FEATURE_FLAGS } from '../../core/feature-flags.js';
import {
  UnsupportedProviderError,
  InvalidProviderSubjectError,
  AccountNotFoundError,
  DuplicateProviderIdentityError,
} from './errors.js';
import { AccountService } from './service.js';

export const DOMAIN_NAME = 'identity';

export const PROVIDER_IDENTITY_UNIQUE_CONSTRAINT = 'uq_v2_provider_identities_provider_subject';

export const SUPPORTED_PROVIDERS = Object.freeze({
  GOOGLE: 'GOOGLE',
  FACEBOOK: 'FACEBOOK',
  THREADS: 'THREADS',
});

export const ACCOUNT_STATES = Object.freeze({
  ACTIVE: 'ACTIVE',
  SUSPENDED: 'SUSPENDED',
  DISABLED: 'DISABLED',
});

export const COMMAND_TYPES = Object.freeze({
  CREATE_ACCOUNT: 'identity.create_account',
  LINK_PROVIDER_IDENTITY: 'identity.link_provider_identity',
  AUTHENTICATE_SESSION: 'identity.authenticate_session',
});

export const EVENT_TYPES = Object.freeze({
  ACCOUNT_CREATED: 'identity.account_created',
  PROVIDER_LINKED: 'identity.provider_linked',
  SESSION_AUTHENTICATED: 'identity.session_authenticated',
});

export const REQUIRED_FEATURE_FLAGS = Object.freeze([
  FEATURE_FLAGS.ACCOUNT_V2,
]);

/**
 * Normalizes and validates a provider string.
 * Provider names are uppercase-normalized before checking against registry.
 * Unknown or empty provider values fail closed.
 *
 * @param {string} provider
 * @returns {string} Normalized provider string
 */
export function validateAndNormalizeProvider(provider) {
  if (!provider || typeof provider !== 'string') {
    throw new UnsupportedProviderError(provider);
  }

  const normalized = provider.trim().toUpperCase();
  if (!Object.values(SUPPORTED_PROVIDERS).includes(normalized)) {
    throw new UnsupportedProviderError(provider);
  }

  return normalized;
}

/**
 * Validates provider_subject as an opaque string.
 * Must be non-empty string. Is NOT transformed or case-altered.
 *
 * @param {string} providerSubject
 * @returns {string} Unaltered providerSubject
 */
export function validateProviderSubject(providerSubject) {
  if (typeof providerSubject !== 'string' || providerSubject.trim() === '') {
    throw new InvalidProviderSubjectError('Provider subject must be a non-empty string.');
  }

  // Prevent excessively huge inputs
  if (providerSubject.length > 256) {
    throw new InvalidProviderSubjectError('Provider subject exceeds maximum length of 256 characters.');
  }

  return providerSubject;
}

export function getDomainMetadata() {
  return {
    domain: DOMAIN_NAME,
    supportedProviders: Object.values(SUPPORTED_PROVIDERS),
    accountStates: Object.values(ACCOUNT_STATES),
    commandTypes: Object.values(COMMAND_TYPES),
    eventTypes: Object.values(EVENT_TYPES),
    requiredFlags: [...REQUIRED_FEATURE_FLAGS],
  };
}

export {
  AccountService,
  UnsupportedProviderError,
  InvalidProviderSubjectError,
  AccountNotFoundError,
  DuplicateProviderIdentityError,
};
