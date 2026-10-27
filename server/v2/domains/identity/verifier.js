/**
 * Provider Verifier Port & Abstract Strategy for V2 Provider Linking.
 */
import {
  validateAndNormalizeProvider,
  validateProviderSubject,
  InvalidProviderAssertionError,
} from './index.js';

export class ProviderVerifierPort {
  /**
   * Verifies a provider assertion payload/token server-side.
   *
   * @param {Object} assertion
   * @param {string} assertion.provider - External provider (GOOGLE, FACEBOOK, THREADS)
   * @param {string} assertion.assertionToken - Opaque proof/token string issued by provider
   * @returns {Promise<{ provider: string, providerSubject: string }>} Verified provider and subject
   */
  async verifyAssertion(assertion) {
    throw new Error('ProviderVerifierPort.verifyAssertion must be implemented by concrete provider verifier.');
  }
}

export class MockProviderVerifier extends ProviderVerifierPort {
  constructor() {
    super();
    this.validTokens = new Map();
  }

  /**
   * Registers a valid token mapping for testing purposes.
   *
   * @param {string} token
   * @param {string} provider
   * @param {string} providerSubject
   */
  registerToken(token, provider, providerSubject) {
    this.validTokens.set(token, { provider, providerSubject });
  }

  async verifyAssertion(assertion) {
    if (!assertion || typeof assertion !== 'object') {
      throw new InvalidProviderAssertionError('Provider assertion must be an object.');
    }

    const { provider, assertionToken } = assertion;
    if (!assertionToken || typeof assertionToken !== 'string' || assertionToken.trim() === '') {
      throw new InvalidProviderAssertionError('Provider assertion must contain a non-empty string assertionToken.');
    }

    const normalizedProvider = validateAndNormalizeProvider(provider);

    // Look up token in mock registry
    if (this.validTokens.has(assertionToken)) {
      const record = this.validTokens.get(assertionToken);
      const recProvider = validateAndNormalizeProvider(record.provider);
      if (recProvider !== normalizedProvider) {
        throw new InvalidProviderAssertionError(`Assertion provider mismatch: expected "${normalizedProvider}", got "${recProvider}".`);
      }
      return {
        provider: recProvider,
        providerSubject: validateProviderSubject(record.providerSubject),
      };
    }

    // Deterministic mock verification pattern: "valid:{provider}:{subject}"
    if (assertionToken.startsWith('valid:')) {
      const parts = assertionToken.split(':');
      if (parts.length === 3 && parts[1].toUpperCase() === normalizedProvider) {
        return {
          provider: normalizedProvider,
          providerSubject: validateProviderSubject(parts[2]),
        };
      }
    }

    throw new InvalidProviderAssertionError(`Failed to verify provider assertion token "${assertionToken}".`);
  }
}
