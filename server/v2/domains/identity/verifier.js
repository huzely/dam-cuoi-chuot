/**
 * V2 Provider Identity Verifier Port & Trusted Principal Abstractions.
 * Establishes server-side boundaries separating untrusted client payloads
 * from trusted authenticated principals and verified provider assertions.
 */

import {
  ACCOUNT_STATES,
  validateAndNormalizeProvider,
  validateProviderSubject,
} from './index.js';
import {
  InvalidTrustedPrincipalError,
  InvalidProviderAssertionError,
  ProviderVerificationRequiredError,
} from './errors.js';

/**
 * Server-established trusted account principal.
 */
export class TrustedPrincipal {
  constructor({ userId, state = ACCOUNT_STATES.ACTIVE }) {
    if (!userId || typeof userId !== 'string' || userId.trim() === '') {
      throw new InvalidTrustedPrincipalError('Trusted principal requires a valid non-empty userId.');
    }

    if (state !== ACCOUNT_STATES.ACTIVE) {
      throw new InvalidTrustedPrincipalError(`Account "${userId}" is in state "${state}" and cannot perform identity mutations.`);
    }

    this.userId = userId;
    this.state = state;
    Object.freeze(this);
  }
}

/**
 * Verified provider identity assertion produced exclusively by a ProviderVerifier.
 */
export class ProviderAssertion {
  constructor({ provider, providerSubject, metadata = {}, verified = true }) {
    if (!verified) {
      throw new InvalidProviderAssertionError('Unverified provider identity assertion rejected.');
    }

    this.provider = validateAndNormalizeProvider(provider);
    this.providerSubject = validateProviderSubject(providerSubject);
    this.metadata = Object.freeze({ ...metadata });
    this.verifiedAt = new Date().toISOString();
    this.isVerified = true;
    Object.freeze(this);
  }
}

/**
 * Abstract Provider Verifier Port interface.
 */
export class ProviderVerifierPort {
  /**
   * Verifies raw server/client credential tokens and produces a trusted ProviderAssertion.
   *
   * @param {Object} params
   * @param {string} params.provider
   * @param {string} params.credential
   * @returns {Promise<ProviderAssertion>}
   */
  async verifyCredential({ provider, credential }) {
    throw new Error('ProviderVerifierPort.verifyCredential() must be implemented by concrete provider verifier adapter.');
  }
}

/**
 * Test & Verification Double implementation of ProviderVerifierPort.
 * Used for testing and application integration before M2.3 live transport.
 */
export class TestProviderVerifier extends ProviderVerifierPort {
  /**
   * @param {Map<string, Object>|Object} [mockCredentialMap]
   */
  constructor(mockCredentialMap = {}) {
    super();
    this.credentialRegistry = new Map(
      mockCredentialMap instanceof Map ? mockCredentialMap : Object.entries(mockCredentialMap)
    );
  }

  /**
   * Registers a mock valid token -> providerSubject mapping for testing.
   */
  registerCredential(credential, { provider, providerSubject, metadata = {} }) {
    this.credentialRegistry.set(credential, {
      provider: validateAndNormalizeProvider(provider),
      providerSubject: validateProviderSubject(providerSubject),
      metadata,
    });
  }

  /**
   * Verifies raw credential token against registry or deterministic test token format.
   *
   * Format supported: "valid_token_<provider>_<subject>"
   */
  async verifyCredential({ provider, credential }) {
    if (!credential || typeof credential !== 'string' || credential.trim() === '') {
      throw new ProviderVerificationRequiredError('Valid provider credential token is required.');
    }

    const normalizedProvider = validateAndNormalizeProvider(provider);

    // 1. Check registry
    if (this.credentialRegistry.has(credential)) {
      const reg = this.credentialRegistry.get(credential);
      if (reg.provider !== normalizedProvider) {
        throw new InvalidProviderAssertionError(`Credential token was issued for provider "${reg.provider}", not "${normalizedProvider}".`);
      }
      return new ProviderAssertion({
        provider: reg.provider,
        providerSubject: reg.providerSubject,
        metadata: reg.metadata,
        verified: true,
      });
    }

    // 2. Deterministic test token parsing: "test_token_GOOGLE_sub123"
    const prefix = `test_token_${normalizedProvider}_`;
    if (credential.startsWith(prefix)) {
      const subject = credential.substring(prefix.length);
      if (subject) {
        return new ProviderAssertion({
          provider: normalizedProvider,
          providerSubject: subject,
          verified: true,
        });
      }
    }

    throw new ProviderVerificationRequiredError(`Provider verification failed for credential token on provider "${normalizedProvider}".`);
  }
}
