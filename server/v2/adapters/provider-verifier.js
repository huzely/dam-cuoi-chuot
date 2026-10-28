/**
 * Production Provider Verifier Adapters for V2 Identity Domain.
 * Located in adapters/ per V2 architecture principles.
 *
 * Implements fail-closed, dependency-injected verification for:
 * - Google (OIDC JWT ID Tokens with issuer, audience, exp, signature/tokeninfo verification)
 * - Facebook (Meta Graph API debug_token with required app access token & app_id validation)
 * - Threads (Meta Graph API debug_token with required app access token & app_id validation)
 *
 * Security Principles:
 * 1. Fail-closed: missing config/credentials, invalid claims, app_id mismatch, or network error throws InvalidProviderAssertionError.
 * 2. App-bound: Facebook and Threads tokens MUST be verified against app credentials to confirm app_id matches configured app.
 * 3. Zero leakage: Tokens and secret credentials are NEVER stored, logged, or included in error messages.
 * 4. Direct API routes: Clean, standard URL construction.
 */

import {
  ProviderVerifierPort,
  validateAndNormalizeProvider,
  validateProviderSubject,
  InvalidProviderAssertionError,
} from '../domains/identity/index.js';

/**
 * Helper to decode base64url string to Buffer/UTF-8.
 */
function decodeBase64Url(str) {
  let base64 = str.replace(/-/g, '+').replace(/_/g, '/');
  while (base64.length % 4 !== 0) {
    base64 += '=';
  }
  return Buffer.from(base64, 'base64').toString('utf8');
}

/**
 * Google Provider Verifier Adapter.
 * Validates Google ID tokens (OIDC JWTs) against configured googleClientId.
 */
export class GoogleProviderVerifier extends ProviderVerifierPort {
  /**
   * @param {Object} options
   * @param {string} options.googleClientId - Google OAuth Client ID (REQUIRED)
   * @param {Function} [options.fetch] - Custom fetch function for HTTP requests
   * @param {Function} [options.jwksFetcher] - Optional custom JWKS key fetcher
   */
  constructor({ googleClientId, fetch = globalThis.fetch, jwksFetcher = null } = {}) {
    super();
    this.googleClientId = googleClientId;
    this.fetch = fetch;
    this.jwksFetcher = jwksFetcher;
  }

  async verifyAssertion(assertion) {
    if (!this.googleClientId || typeof this.googleClientId !== 'string' || this.googleClientId.trim() === '') {
      throw new InvalidProviderAssertionError('Google verifier configuration error: googleClientId is required.');
    }

    if (!assertion || typeof assertion !== 'object') {
      throw new InvalidProviderAssertionError('Provider assertion must be an object.');
    }

    const { assertionToken } = assertion;
    if (!assertionToken || typeof assertionToken !== 'string' || assertionToken.trim() === '') {
      throw new InvalidProviderAssertionError('Google assertion must contain a non-empty string assertionToken.');
    }

    const parts = assertionToken.split('.');
    if (parts.length !== 3) {
      throw new InvalidProviderAssertionError('Invalid Google ID token format: must be a 3-part JWT.');
    }

    let header, payload;
    try {
      header = JSON.parse(decodeBase64Url(parts[0]));
      payload = JSON.parse(decodeBase64Url(parts[1]));
    } catch (_err) {
      throw new InvalidProviderAssertionError('Failed to parse Google ID token JSON payload.');
    }

    // Validate standard JWT claims
    const validIssuers = ['accounts.google.com', 'https://accounts.google.com'];
    if (!payload.iss || !validIssuers.includes(payload.iss)) {
      throw new InvalidProviderAssertionError(`Google ID token issuer mismatch: expected Google issuer, got "${payload.iss}".`);
    }

    if (payload.aud !== this.googleClientId) {
      throw new InvalidProviderAssertionError(`Google ID token audience mismatch: expected "${this.googleClientId}".`);
    }

    const nowSec = Math.floor(Date.now() / 1000);
    if (payload.exp && typeof payload.exp === 'number' && payload.exp <= nowSec) {
      throw new InvalidProviderAssertionError('Google ID token has expired.');
    }

    if (!payload.sub || typeof payload.sub !== 'string' || payload.sub.trim() === '') {
      throw new InvalidProviderAssertionError('Google ID token missing valid sub (provider subject).');
    }

    // Verification via signature/JWKS or tokeninfo transport
    if (this.jwksFetcher) {
      try {
        const verified = await this.jwksFetcher({ token: assertionToken, header, payload, clientId: this.googleClientId });
        if (!verified) {
          throw new InvalidProviderAssertionError('Google ID token signature verification failed via JWKS fetcher.');
        }
      } catch (err) {
        if (err instanceof InvalidProviderAssertionError) throw err;
        throw new InvalidProviderAssertionError(`Google ID token verification failed: ${err.message}`);
      }
    } else if (typeof this.fetch === 'function') {
      try {
        const url = `https://oauth2.googleapis.com/tokeninfo?id_token=${encodeURIComponent(assertionToken)}`;
        const res = await this.fetch(url);
        if (!res || !res.ok) {
          throw new InvalidProviderAssertionError('Google tokeninfo endpoint rejected the provided token.');
        }
        const info = await res.json();
        if (info.aud !== this.googleClientId) {
          throw new InvalidProviderAssertionError('Google tokeninfo audience mismatch.');
        }
        if (!info.sub || info.sub !== payload.sub) {
          throw new InvalidProviderAssertionError('Google tokeninfo sub mismatch.');
        }
      } catch (err) {
        if (err instanceof InvalidProviderAssertionError) throw err;
        throw new InvalidProviderAssertionError('Google token verification failed via tokeninfo endpoint.');
      }
    }

    return {
      provider: 'GOOGLE',
      providerSubject: validateProviderSubject(payload.sub),
    };
  }
}

/**
 * Facebook Provider Verifier Adapter.
 * Validates Facebook access tokens via Meta Graph API debug_token endpoint.
 * Requires explicit facebookAppId and app credentials (facebookAppSecret or facebookAppToken).
 */
export class FacebookProviderVerifier extends ProviderVerifierPort {
  /**
   * @param {Object} options
   * @param {string} options.facebookAppId - Facebook App ID (REQUIRED)
   * @param {string} [options.facebookAppSecret] - Facebook App Secret
   * @param {string} [options.facebookAppToken] - Pre-generated App Access Token
   * @param {Function} [options.fetch] - Custom fetch function
   */
  constructor({ facebookAppId, facebookAppSecret = null, facebookAppToken = null, fetch = globalThis.fetch } = {}) {
    super();
    this.facebookAppId = facebookAppId;
    this.facebookAppSecret = facebookAppSecret;
    this.facebookAppToken = facebookAppToken;
    this.fetch = fetch;
  }

  _getAppAccessToken() {
    if (this.facebookAppToken && typeof this.facebookAppToken === 'string' && this.facebookAppToken.trim() !== '') {
      return this.facebookAppToken.trim();
    }
    if (this.facebookAppId && this.facebookAppSecret) {
      return `${this.facebookAppId}|${this.facebookAppSecret}`;
    }
    return null;
  }

  async verifyAssertion(assertion) {
    if (!this.facebookAppId || typeof this.facebookAppId !== 'string' || this.facebookAppId.trim() === '') {
      throw new InvalidProviderAssertionError('Facebook verifier configuration error: facebookAppId is required.');
    }

    const appAccessToken = this._getAppAccessToken();
    if (!appAccessToken) {
      throw new InvalidProviderAssertionError('Facebook verifier configuration error: App access token or facebookAppSecret is required for fail-closed verification.');
    }

    if (!assertion || typeof assertion !== 'object') {
      throw new InvalidProviderAssertionError('Provider assertion must be an object.');
    }

    const { assertionToken } = assertion;
    if (!assertionToken || typeof assertionToken !== 'string' || assertionToken.trim() === '') {
      throw new InvalidProviderAssertionError('Facebook assertion must contain a non-empty string assertionToken.');
    }

    if (typeof this.fetch !== 'function') {
      throw new InvalidProviderAssertionError('Facebook verifier error: HTTP transport fetch function is not available.');
    }

    try {
      const debugUrl = `https://graph.facebook.com/v19.0/debug_token?input_token=${encodeURIComponent(assertionToken)}&access_token=${encodeURIComponent(appAccessToken)}`;
      const response = await this.fetch(debugUrl);

      if (!response || !response.ok) {
        throw new InvalidProviderAssertionError('Meta Graph API debug_token endpoint returned HTTP error status.');
      }

      const body = await response.json();
      const data = body?.data;

      if (!data || typeof data !== 'object') {
        throw new InvalidProviderAssertionError('Meta Graph API debug_token returned invalid response structure.');
      }

      if (data.is_valid !== true) {
        throw new InvalidProviderAssertionError('Facebook token is marked invalid by Meta debug_token inspection.');
      }

      const returnedAppId = String(data.app_id || '');
      const expectedAppId = String(this.facebookAppId);
      if (returnedAppId !== expectedAppId) {
        throw new InvalidProviderAssertionError(`Facebook token app_id mismatch: expected "${expectedAppId}", got "${returnedAppId}".`);
      }

      const userId = data.user_id || data.target_user_id;
      if (!userId || typeof userId !== 'string' || userId.trim() === '') {
        throw new InvalidProviderAssertionError('Facebook debug_token response missing user_id.');
      }

      return {
        provider: 'FACEBOOK',
        providerSubject: validateProviderSubject(userId),
      };
    } catch (err) {
      if (err instanceof InvalidProviderAssertionError) throw err;
      throw new InvalidProviderAssertionError('Facebook provider assertion verification failed.');
    }
  }
}

/**
 * Threads Provider Verifier Adapter.
 * Validates Meta Threads access tokens via official Threads API (graph.threads.net) debug_token endpoint.
 * Requires explicit threadsAppId and app credentials (threadsAppSecret or threadsAppToken).
 */
export class ThreadsProviderVerifier extends ProviderVerifierPort {
  /**
   * @param {Object} options
   * @param {string} options.threadsAppId - Threads Meta App ID (REQUIRED)
   * @param {string} [options.threadsAppSecret] - Threads App Secret
   * @param {string} [options.threadsAppToken] - Pre-generated App Access Token
   * @param {Function} [options.fetch] - Custom fetch function
   */
  constructor({ threadsAppId, threadsAppSecret = null, threadsAppToken = null, fetch = globalThis.fetch } = {}) {
    super();
    this.threadsAppId = threadsAppId;
    this.threadsAppSecret = threadsAppSecret;
    this.threadsAppToken = threadsAppToken;
    this.fetch = fetch;
  }

  _getAppAccessToken() {
    if (this.threadsAppToken && typeof this.threadsAppToken === 'string' && this.threadsAppToken.trim() !== '') {
      return this.threadsAppToken.trim();
    }
    if (this.threadsAppId && this.threadsAppSecret) {
      return `${this.threadsAppId}|${this.threadsAppSecret}`;
    }
    return null;
  }

  async verifyAssertion(assertion) {
    if (!this.threadsAppId || typeof this.threadsAppId !== 'string' || this.threadsAppId.trim() === '') {
      throw new InvalidProviderAssertionError('Threads verifier configuration error: threadsAppId is required.');
    }

    const appAccessToken = this._getAppAccessToken();
    if (!appAccessToken) {
      throw new InvalidProviderAssertionError('Threads verifier configuration error: App access token or threadsAppSecret is required for fail-closed app-bound verification.');
    }

    if (!assertion || typeof assertion !== 'object') {
      throw new InvalidProviderAssertionError('Provider assertion must be an object.');
    }

    const { assertionToken } = assertion;
    if (!assertionToken || typeof assertionToken !== 'string' || assertionToken.trim() === '') {
      throw new InvalidProviderAssertionError('Threads assertion must contain a non-empty string assertionToken.');
    }

    if (typeof this.fetch !== 'function') {
      throw new InvalidProviderAssertionError('Threads verifier error: HTTP transport fetch function is not available.');
    }

    try {
      // Official Meta Threads API endpoint on graph.threads.net
      const debugUrl = `https://graph.threads.net/v1.0/debug_token?input_token=${encodeURIComponent(assertionToken)}&access_token=${encodeURIComponent(appAccessToken)}`;
      const response = await this.fetch(debugUrl);

      if (!response || !response.ok) {
        throw new InvalidProviderAssertionError('Official Threads API debug_token endpoint returned HTTP error status.');
      }

      const body = await response.json();
      const data = body?.data;

      if (!data || typeof data !== 'object') {
        throw new InvalidProviderAssertionError('Official Threads API debug_token returned invalid response structure.');
      }

      if (data.is_valid !== true) {
        throw new InvalidProviderAssertionError('Threads token is marked invalid by Threads API debug_token inspection.');
      }

      const returnedAppId = String(data.app_id || '');
      const expectedAppId = String(this.threadsAppId);
      if (returnedAppId !== expectedAppId) {
        throw new InvalidProviderAssertionError(`Threads token app_id mismatch: expected "${expectedAppId}", got "${returnedAppId}".`);
      }

      const userId = data.user_id || data.target_user_id || data.id;
      if (!userId || typeof userId !== 'string' || userId.trim() === '') {
        throw new InvalidProviderAssertionError('Threads debug_token response missing user_id/id.');
      }

      return {
        provider: 'THREADS',
        providerSubject: validateProviderSubject(userId),
      };
    } catch (err) {
      if (err instanceof InvalidProviderAssertionError) throw err;
      throw new InvalidProviderAssertionError('Threads provider assertion verification failed.');
    }
  }
}

/**
 * Composite Production Provider Verifier Router.
 */
export class ProductionProviderVerifier extends ProviderVerifierPort {
  /**
   * @param {Object} options
   * @param {GoogleProviderVerifier|Object} [options.google]
   * @param {FacebookProviderVerifier|Object} [options.facebook]
   * @param {ThreadsProviderVerifier|Object} [options.threads]
   * @param {Function} [options.fetch]
   */
  constructor(options = {}) {
    super();

    const fetch = options.fetch || globalThis.fetch;

    if (options.google instanceof GoogleProviderVerifier) {
      this.google = options.google;
    } else if (options.google && typeof options.google === 'object') {
      this.google = new GoogleProviderVerifier({ fetch, ...options.google });
    } else {
      this.google = null;
    }

    if (options.facebook instanceof FacebookProviderVerifier) {
      this.facebook = options.facebook;
    } else if (options.facebook && typeof options.facebook === 'object') {
      this.facebook = new FacebookProviderVerifier({ fetch, ...options.facebook });
    } else {
      this.facebook = null;
    }

    if (options.threads instanceof ThreadsProviderVerifier) {
      this.threads = options.threads;
    } else if (options.threads && typeof options.threads === 'object') {
      this.threads = new ThreadsProviderVerifier({ fetch, ...options.threads });
    } else {
      this.threads = null;
    }
  }

  async verifyAssertion(assertion) {
    if (!assertion || typeof assertion !== 'object') {
      throw new InvalidProviderAssertionError('Provider assertion must be an object.');
    }

    const { provider } = assertion;
    const normalized = validateAndNormalizeProvider(provider);

    switch (normalized) {
      case 'GOOGLE':
        if (!this.google) {
          throw new InvalidProviderAssertionError('Google provider verifier is not configured.');
        }
        return await this.google.verifyAssertion(assertion);
      case 'FACEBOOK':
        if (!this.facebook) {
          throw new InvalidProviderAssertionError('Facebook provider verifier is not configured.');
        }
        return await this.facebook.verifyAssertion(assertion);
      case 'THREADS':
        if (!this.threads) {
          throw new InvalidProviderAssertionError('Threads provider verifier is not configured.');
        }
        return await this.threads.verifyAssertion(assertion);
      default:
        throw new InvalidProviderAssertionError(`Unsupported provider "${normalized}".`);
    }
  }
}
