/**
 * Identity Domain Errors
 */

export class UnsupportedProviderError extends Error {
  constructor(provider) {
    super(`Unsupported provider "${provider}". Supported providers: GOOGLE, FACEBOOK, THREADS.`);
    this.name = 'UnsupportedProviderError';
    this.code = 'UNSUPPORTED_PROVIDER';
    this.provider = provider;
  }
}

export class InvalidProviderSubjectError extends Error {
  constructor(message = 'Provider subject must be a non-empty string.') {
    super(message);
    this.name = 'InvalidProviderSubjectError';
    this.code = 'INVALID_PROVIDER_SUBJECT';
  }
}

export class AccountNotFoundError extends Error {
  constructor(userId) {
    super(`Account not found for user_id: "${userId}".`);
    this.name = 'AccountNotFoundError';
    this.code = 'ACCOUNT_NOT_FOUND';
    this.userId = userId;
  }
}

export class DuplicateProviderIdentityError extends Error {
  constructor(provider, providerSubject) {
    super(`Provider identity (${provider}, ${providerSubject}) is already linked to another account.`);
    this.name = 'DuplicateProviderIdentityError';
    this.code = 'DUPLICATE_PROVIDER_IDENTITY';
    this.provider = provider;
    this.providerSubject = providerSubject;
  }
}

export class InvalidAccountStateError extends Error {
  constructor(userId, state, action = 'link provider identity') {
    super(`Account "${userId}" in state "${state}" is prohibited from action: ${action}. Account must be ACTIVE.`);
    this.name = 'InvalidAccountStateError';
    this.code = 'INVALID_ACCOUNT_STATE';
    this.userId = userId;
    this.state = state;
  }
}

export class InvalidProviderAssertionError extends Error {
  constructor(message = 'Invalid or unverified provider assertion.') {
    super(message);
    this.name = 'InvalidProviderAssertionError';
    this.code = 'INVALID_PROVIDER_ASSERTION';
  }
}
