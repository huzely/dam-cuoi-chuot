import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { HttpProviderVerifier } from '../domains/identity/verifier.js';

describe('HttpProviderVerifier Sanitization', () => {
  it('sanitizes exception messages to prevent token or secret leakage on Google verification failure', async () => {
    const verifier = new HttpProviderVerifier({
      googleClientId: 'google_client_id_123',
      fetchImpl: async () => {
        throw new Error('Sensitive google_oauth_token_secret_12345 in URL https://oauth2.googleapis.com/tokeninfo?id_token=SECRET_JWT');
      }
    });

    await assert.rejects(
      async () => {
        await verifier.verifyAssertion({
          provider: 'GOOGLE',
          assertionToken: 'SECRET_JWT_TOKEN'
        });
      },
      (err) => {
        assert.equal(err.message, 'Google tokeninfo network request failed.');
        assert.doesNotMatch(err.message, /secret/i);
        assert.doesNotMatch(err.message, /JWT/i);
        return true;
      }
    );
  });

  it('sanitizes exception messages on Facebook token verification failure', async () => {
    const verifier = new HttpProviderVerifier({
      facebookAppId: 'fb_app_id_123',
      facebookAppSecret: 'fb_app_secret_456',
      fetchImpl: async () => {
        throw new Error('Sensitive fb_access_token_secret_789 leaked');
      }
    });

    await assert.rejects(
      async () => {
        await verifier.verifyAssertion({
          provider: 'FACEBOOK',
          assertionToken: 'SECRET_FB_TOKEN'
        });
      },
      (err) => {
        assert.equal(err.message, 'Facebook debug_token network request failed.');
        assert.doesNotMatch(err.message, /secret/i);
        return true;
      }
    );
  });

  it('sanitizes exception messages on Threads token verification failure', async () => {
    const verifier = new HttpProviderVerifier({
      threadsAppId: 'threads_app_id_123',
      threadsAppSecret: 'threads_app_secret_456',
      fetchImpl: async () => {
        throw new Error('Sensitive threads_token_secret_999 leaked');
      }
    });

    await assert.rejects(
      async () => {
        await verifier.verifyAssertion({
          provider: 'THREADS',
          assertionToken: 'SECRET_THREADS_TOKEN'
        });
      },
      (err) => {
        assert.equal(err.message, 'Threads API network request failed.');
        assert.doesNotMatch(err.message, /secret/i);
        return true;
      }
    );
  });
});
