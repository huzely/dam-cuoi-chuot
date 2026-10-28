import test from 'node:test';
import assert from 'node:assert/strict';

import {
  GoogleProviderVerifier,
  FacebookProviderVerifier,
  ThreadsProviderVerifier,
  ProductionProviderVerifier,
  InvalidProviderAssertionError,
} from '../domains/identity/index.js';

function makeJwt(payloadObj, headerObj = { alg: 'RS256', typ: 'JWT' }) {
  const encHeader = Buffer.from(JSON.stringify(headerObj)).toString('base64url');
  const encPayload = Buffer.from(JSON.stringify(payloadObj)).toString('base64url');
  const signature = Buffer.from('mock-signature').toString('base64url');
  return `${encHeader}.${encPayload}.${signature}`;
}

test('GoogleProviderVerifier: fails closed when googleClientId is omitted', async () => {
  const verifier = new GoogleProviderVerifier({});
  await assert.rejects(
    verifier.verifyAssertion({ provider: 'GOOGLE', assertionToken: 'some.jwt.token' }),
    InvalidProviderAssertionError
  );
});

test('GoogleProviderVerifier: rejects non-JWT assertionToken', async () => {
  const verifier = new GoogleProviderVerifier({ googleClientId: 'client-123' });
  await assert.rejects(
    verifier.verifyAssertion({ provider: 'GOOGLE', assertionToken: 'not-a-jwt' }),
    InvalidProviderAssertionError
  );
});

test('GoogleProviderVerifier: rejects token with wrong issuer', async () => {
  const verifier = new GoogleProviderVerifier({ googleClientId: 'client-123' });
  const jwt = makeJwt({
    iss: 'https://evil.com',
    aud: 'client-123',
    sub: 'user-789',
    exp: Math.floor(Date.now() / 1000) + 3600,
  });
  await assert.rejects(
    verifier.verifyAssertion({ provider: 'GOOGLE', assertionToken: jwt }),
    InvalidProviderAssertionError
  );
});

test('GoogleProviderVerifier: rejects token with wrong audience', async () => {
  const verifier = new GoogleProviderVerifier({ googleClientId: 'client-123' });
  const jwt = makeJwt({
    iss: 'https://accounts.google.com',
    aud: 'wrong-client',
    sub: 'user-789',
    exp: Math.floor(Date.now() / 1000) + 3600,
  });
  await assert.rejects(
    verifier.verifyAssertion({ provider: 'GOOGLE', assertionToken: jwt }),
    InvalidProviderAssertionError
  );
});

test('GoogleProviderVerifier: rejects expired token', async () => {
  const verifier = new GoogleProviderVerifier({ googleClientId: 'client-123' });
  const jwt = makeJwt({
    iss: 'https://accounts.google.com',
    aud: 'client-123',
    sub: 'user-789',
    exp: Math.floor(Date.now() / 1000) - 100,
  });
  await assert.rejects(
    verifier.verifyAssertion({ provider: 'GOOGLE', assertionToken: jwt }),
    InvalidProviderAssertionError
  );
});

test('GoogleProviderVerifier: verifies valid token with JWKS fetcher', async () => {
  const verifier = new GoogleProviderVerifier({
    googleClientId: 'client-123',
    jwksFetcher: async () => true,
  });
  const jwt = makeJwt({
    iss: 'https://accounts.google.com',
    aud: 'client-123',
    sub: 'google-sub-456',
    exp: Math.floor(Date.now() / 1000) + 3600,
  });
  const res = await verifier.verifyAssertion({ provider: 'GOOGLE', assertionToken: jwt });
  assert.equal(res.provider, 'GOOGLE');
  assert.equal(res.providerSubject, 'google-sub-456');
});

test('FacebookProviderVerifier: fails closed when facebookAppId or app secret/token is missing', async () => {
  // Missing app secret/token
  const verifierNoSecret = new FacebookProviderVerifier({ facebookAppId: 'app-fb-1' });
  await assert.rejects(
    verifierNoSecret.verifyAssertion({ provider: 'FACEBOOK', assertionToken: 'user-fb-token' }),
    InvalidProviderAssertionError
  );

  // Missing app ID
  const verifierNoAppId = new FacebookProviderVerifier({ facebookAppSecret: 'sec-fb-1' });
  await assert.rejects(
    verifierNoAppId.verifyAssertion({ provider: 'FACEBOOK', assertionToken: 'user-fb-token' }),
    InvalidProviderAssertionError
  );
});

test('FacebookProviderVerifier: rejects when debug_token reports is_valid = false', async () => {
  const mockFetch = async () => ({
    ok: true,
    json: async () => ({ data: { is_valid: false } }),
  });

  const verifier = new FacebookProviderVerifier({
    facebookAppId: 'app-fb-1',
    facebookAppSecret: 'sec-fb-1',
    fetch: mockFetch,
  });

  await assert.rejects(
    verifier.verifyAssertion({ provider: 'FACEBOOK', assertionToken: 'invalid-fb-token' }),
    InvalidProviderAssertionError
  );
});

test('FacebookProviderVerifier: rejects when app_id does not match configured facebookAppId', async () => {
  const mockFetch = async () => ({
    ok: true,
    json: async () => ({
      data: { is_valid: true, app_id: 'other-app-id', user_id: 'fb-user-123' },
    }),
  });

  const verifier = new FacebookProviderVerifier({
    facebookAppId: 'app-fb-1',
    facebookAppSecret: 'sec-fb-1',
    fetch: mockFetch,
  });

  await assert.rejects(
    verifier.verifyAssertion({ provider: 'FACEBOOK', assertionToken: 'fb-token' }),
    InvalidProviderAssertionError
  );
});

test('FacebookProviderVerifier: verifies valid token with matching app_id and returns user_id', async () => {
  const mockFetch = async (url) => {
    assert.ok(url.includes('graph.facebook.com'));
    assert.ok(url.includes('access_token=app-fb-1%7Csec-fb-1'));
    return {
      ok: true,
      json: async () => ({
        data: { is_valid: true, app_id: 'app-fb-1', user_id: 'fb-user-999' },
      }),
    };
  };

  const verifier = new FacebookProviderVerifier({
    facebookAppId: 'app-fb-1',
    facebookAppSecret: 'sec-fb-1',
    fetch: mockFetch,
  });

  const res = await verifier.verifyAssertion({ provider: 'FACEBOOK', assertionToken: 'valid-fb-user-token' });
  assert.equal(res.provider, 'FACEBOOK');
  assert.equal(res.providerSubject, 'fb-user-999');
});

test('ThreadsProviderVerifier: fails closed when threadsAppId or app secret/token is missing', async () => {
  const verifierNoSecret = new ThreadsProviderVerifier({ threadsAppId: 'app-threads-1' });
  await assert.rejects(
    verifierNoSecret.verifyAssertion({ provider: 'THREADS', assertionToken: 'threads-user-token' }),
    InvalidProviderAssertionError
  );
});

test('ThreadsProviderVerifier: calls official Threads endpoint graph.threads.net and validates app_id', async () => {
  let queriedUrl = null;
  const mockFetch = async (url) => {
    queriedUrl = url;
    return {
      ok: true,
      json: async () => ({
        data: { is_valid: true, app_id: 'app-threads-1', user_id: 'th-user-888' },
      }),
    };
  };

  const verifier = new ThreadsProviderVerifier({
    threadsAppId: 'app-threads-1',
    threadsAppSecret: 'sec-threads-1',
    fetch: mockFetch,
  });

  const res = await verifier.verifyAssertion({ provider: 'THREADS', assertionToken: 'valid-threads-token' });
  assert.equal(res.provider, 'THREADS');
  assert.equal(res.providerSubject, 'th-user-888');
  assert.ok(queriedUrl.startsWith('https://graph.threads.net/v1.0/debug_token'));
  assert.ok(queriedUrl.includes('access_token=app-threads-1%7Csec-threads-1'));
});

test('ThreadsProviderVerifier: rejects when debug_token app_id mismatch or token invalid', async () => {
  const mockFetch = async () => ({
    ok: true,
    json: async () => ({
      data: { is_valid: true, app_id: 'wrong-threads-app', user_id: 'th-user-111' },
    }),
  });

  const verifier = new ThreadsProviderVerifier({
    threadsAppId: 'app-threads-1',
    threadsAppSecret: 'sec-threads-1',
    fetch: mockFetch,
  });

  await assert.rejects(
    verifier.verifyAssertion({ provider: 'THREADS', assertionToken: 'th-token' }),
    InvalidProviderAssertionError
  );
});

test('ProductionProviderVerifier: routes requests to configured verifiers', async () => {
  const googleJwt = makeJwt({
    iss: 'https://accounts.google.com',
    aud: 'g-client-id',
    sub: 'g-user-1',
    exp: Math.floor(Date.now() / 1000) + 3600,
  });

  const mockFetch = async () => ({
    ok: true,
    json: async () => ({
      data: { is_valid: true, app_id: 'fb-app-1', user_id: 'fb-user-1' },
    }),
  });

  const composite = new ProductionProviderVerifier({
    google: { googleClientId: 'g-client-id', jwksFetcher: async () => true },
    facebook: { facebookAppId: 'fb-app-1', facebookAppSecret: 'fb-sec-1', fetch: mockFetch },
  });

  const gRes = await composite.verifyAssertion({ provider: 'GOOGLE', assertionToken: googleJwt });
  assert.equal(gRes.providerSubject, 'g-user-1');

  const fbRes = await composite.verifyAssertion({ provider: 'FACEBOOK', assertionToken: 'fb-tok' });
  assert.equal(fbRes.providerSubject, 'fb-user-1');

  await assert.rejects(
    composite.verifyAssertion({ provider: 'THREADS', assertionToken: 'th-tok' }),
    InvalidProviderAssertionError
  );
});
