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

export class HttpProviderVerifier extends ProviderVerifierPort {
  /**
   * Production-ready concrete verifier adapter with dependency-injected configuration and transport.
   *
   * @param {Object} [config={}]
   * @param {string} [config.googleClientId]
   * @param {string} [config.facebookAppId]
   * @param {string} [config.facebookAppSecret]
   * @param {string} [config.facebookAppAccessToken]
   * @param {string} [config.threadsAppId]
   * @param {string} [config.threadsAppSecret]
   * @param {string} [config.threadsAppAccessToken]
   * @param {Function} [config.fetchImpl] - Dependency-injected fetch implementation
   */
  constructor(config = {}) {
    super();
    this.googleClientId = config.googleClientId || process.env.GOOGLE_CLIENT_ID || null;
    this.facebookAppId = config.facebookAppId || process.env.FACEBOOK_APP_ID || null;
    this.facebookAppSecret = config.facebookAppSecret || process.env.FACEBOOK_APP_SECRET || null;
    this.facebookAppAccessToken = config.facebookAppAccessToken || process.env.FACEBOOK_APP_ACCESS_TOKEN || null;
    this.threadsAppId = config.threadsAppId || process.env.THREADS_APP_ID || null;
    this.threadsAppSecret = config.threadsAppSecret || process.env.THREADS_APP_SECRET || null;
    this.threadsAppAccessToken = config.threadsAppAccessToken || process.env.THREADS_APP_ACCESS_TOKEN || null;
    this.fetchImpl = config.fetchImpl || globalThis.fetch;

    if (typeof this.fetchImpl !== 'function') {
      throw new Error('HttpProviderVerifier requires a valid fetch implementation.');
    }
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

    if (normalizedProvider === 'GOOGLE') {
      return await this._verifyGoogle(assertionToken.trim());
    } else if (normalizedProvider === 'FACEBOOK') {
      return await this._verifyFacebook(assertionToken.trim());
    } else if (normalizedProvider === 'THREADS') {
      return await this._verifyThreads(assertionToken.trim());
    }

    throw new InvalidProviderAssertionError(`Unsupported provider "${provider}".`);
  }

  async _verifyGoogle(idToken) {
    if (!this.googleClientId) {
      throw new InvalidProviderAssertionError('Google verification requires configured googleClientId.');
    }

    let response;
    try {
      response = await this.fetchImpl(`https://oauth2.googleapis.com/tokeninfo?id_token=${encodeURIComponent(idToken)}`);
    } catch (err) {
      throw new InvalidProviderAssertionError(`Google tokeninfo request failed: ${err.message}`);
    }

    if (!response || !response.ok) {
      throw new InvalidProviderAssertionError('Google ID token verification failed or token is invalid.');
    }

    let payload;
    try {
      payload = await response.json();
    } catch (err) {
      throw new InvalidProviderAssertionError('Failed to parse Google tokeninfo response.');
    }

    // Verify audience matches configured googleClientId
    if (payload.aud !== this.googleClientId) {
      throw new InvalidProviderAssertionError(`Google ID token audience mismatch: expected "${this.googleClientId}", got "${payload.aud}".`);
    }

    // Verify issuer is Google
    const validIssuers = ['accounts.google.com', 'https://accounts.google.com'];
    if (!validIssuers.includes(payload.iss)) {
      throw new InvalidProviderAssertionError(`Google ID token invalid issuer "${payload.iss}".`);
    }

    if (!payload.sub || typeof payload.sub !== 'string') {
      throw new InvalidProviderAssertionError('Google tokeninfo payload missing subject (sub).');
    }

    return {
      provider: 'GOOGLE',
      providerSubject: validateProviderSubject(payload.sub),
    };
  }

  async _verifyFacebook(authToken) {
    if (!this.facebookAppId) {
      throw new InvalidProviderAssertionError('Facebook verification requires configured facebookAppId.');
    }

    let appAccessToken = this.facebookAppAccessToken;
    if (!appAccessToken) {
      if (!this.facebookAppSecret) {
        throw new InvalidProviderAssertionError('Facebook verification requires configured facebookAppSecret or facebookAppAccessToken.');
      }
      appAccessToken = `${encodeURIComponent(this.facebookAppId)}|${encodeURIComponent(this.facebookAppSecret)}`;
    }

    let response;
    try {
      response = await this.fetchImpl(`https://graph.facebook.com/debug_token?input_token=${encodeURIComponent(authToken)}&access_token=${appAccessToken}`);
    } catch (err) {
      throw new InvalidProviderAssertionError(`Facebook debug_token request failed: ${err.message}`);
    }

    if (!response || !response.ok) {
      throw new InvalidProviderAssertionError('Facebook token inspection request failed.');
    }

    let result;
    try {
      result = await response.json();
    } catch (err) {
      throw new InvalidProviderAssertionError('Failed to parse Facebook debug_token response.');
    }

    const data = result?.data;
    if (!data || !data.is_valid) {
      throw new InvalidProviderAssertionError('Facebook access token is invalid or expired.');
    }

    if (String(data.app_id) !== String(this.facebookAppId)) {
      throw new InvalidProviderAssertionError(`Facebook token app_id mismatch: expected "${this.facebookAppId}", got "${data.app_id}".`);
    }

    if (!data.user_id) {
      throw new InvalidProviderAssertionError('Facebook debug_token response missing user_id.');
    }

    return {
      provider: 'FACEBOOK',
      providerSubject: validateProviderSubject(String(data.user_id)),
    };
  }

  async _verifyThreads(authToken) {
    if (!this.threadsAppId) {
      throw new InvalidProviderAssertionError('Threads verification requires configured threadsAppId.');
    }

    let appAccessToken = this.threadsAppAccessToken;
    if (!appAccessToken) {
      if (!this.threadsAppSecret) {
        throw new InvalidProviderAssertionError('Threads verification requires configured threadsAppSecret or threadsAppAccessToken.');
      }
      appAccessToken = `${encodeURIComponent(this.threadsAppId)}|${encodeURIComponent(this.threadsAppSecret)}`;
    }

    let response;
    try {
      response = await this.fetchImpl(`https://graph.facebook.com/debug_token?input_token=${encodeURIComponent(authToken)}&access_token=${appAccessToken}`);
    } catch (err) {
      throw new InvalidProviderAssertionError(`Threads debug_token request failed: ${err.message}`);
    }

    if (!response || !response.ok) {
      throw new InvalidProviderAssertionError('Threads token verification request failed.');
    }

    let result;
    try {
      result = await response.json();
    } catch (err) {
      throw new InvalidProviderAssertionError('Failed to parse Threads debug_token response.');
    }

    const data = result?.data;
    if (!data || !data.is_valid) {
      throw new InvalidProviderAssertionError('Threads access token is invalid or expired.');
    }

    if (String(data.app_id) !== String(this.threadsAppId)) {
      throw new InvalidProviderAssertionError(`Threads token app_id mismatch: expected "${this.threadsAppId}", got "${data.app_id}".`);
    }

    if (!data.user_id) {
      throw new InvalidProviderAssertionError('Threads debug_token response missing user_id.');
    }

    return {
      provider: 'THREADS',
      providerSubject: validateProviderSubject(String(data.user_id)),
    };
  }
}
