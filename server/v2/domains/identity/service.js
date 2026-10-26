/**
 * V2 Account / Auth Domain Service.
 * Manages V2 accounts, provider identity mappings, domain invariants,
 * PostgreSQL concurrency error translation, and transactional outbox events.
 */

import { MissingDatabaseDriverError } from '../../adapters/pg-idempotency.js';
import { createDomainEvent } from '../../core/event.js';
import {
  ACCOUNT_STATES,
  EVENT_TYPES,
  PROVIDER_IDENTITY_UNIQUE_CONSTRAINT,
  validateAndNormalizeProvider,
  validateProviderSubject,
  AccountNotFoundError,
  DuplicateProviderIdentityError,
  InvalidTrustedPrincipalError,
  InvalidProviderAssertionError,
  ProviderVerificationRequiredError,
} from './index.js';
import {
  TrustedPrincipal,
  ProviderAssertion,
} from './verifier.js';

export class AccountService {
  /**
   * @param {Object} params
   * @param {Object} params.pgDriver - PostgreSQL Driver adapter (REQUIRED)
   */
  constructor({ pgDriver }) {
    if (!pgDriver) {
      throw new MissingDatabaseDriverError('AccountService');
    }
    this.pgDriver = pgDriver;
  }

  /**
   * Creates a new V2 account with an immutable UUID user_id.
   *
   * @param {Object} [params]
   * @param {string} [params.state='ACTIVE'] - Initial account state
   * @param {Object} [tx] - Optional active transaction handle
   * @returns {Promise<Object>} Account record
   */
  async createAccount(params = {}, tx = null) {
    const state = params.state || ACCOUNT_STATES.ACTIVE;
    if (!Object.values(ACCOUNT_STATES).includes(state)) {
      throw new Error(`Invalid account state "${state}". Allowed states: ACTIVE, SUSPENDED, DISABLED.`);
    }

    const execute = async (activeTx) => {
      const account = await activeTx.accounts.create({ state });

      // Record outbox domain event atomically within transaction
      const event = createDomainEvent({
        eventType: EVENT_TYPES.ACCOUNT_CREATED,
        aggregate: { type: 'account', id: account.userId },
        payload: {
          userId: account.userId,
          state: account.state,
          createdAt: account.createdAt,
        },
      });
      activeTx.outbox.record(event);

      return account;
    };

    if (tx) {
      return await execute(tx);
    }
    return await this.pgDriver.withTransaction(execute);
  }

  /**
   * Retrieves a V2 account by its immutable user_id.
   *
   * @param {string} userId - UUID string
   * @param {Object} [tx] - Optional active transaction handle
   * @returns {Promise<Object|null>} Account record or null
   */
  async getAccountById(userId, tx = null) {
    if (!userId || typeof userId !== 'string') {
      return null;
    }

    const execute = async (activeTx) => {
      return await activeTx.accounts.getById(userId);
    };

    if (tx) {
      return await execute(tx);
    }
    return await this.pgDriver.withTransaction(execute);
  }

  /**
   * Resolves a provider identity to its owner account user_id.
   *
   * @param {string} provider - External provider name (GOOGLE, FACEBOOK, THREADS)
   * @param {string} providerSubject - Provider stable account ID
   * @param {Object} [tx] - Optional active transaction handle
   * @returns {Promise<Object|null>} Provider identity record or null
   */
  async resolveProviderIdentity(provider, providerSubject, tx = null) {
    const normalizedProvider = validateAndNormalizeProvider(provider);
    const validSubject = validateProviderSubject(providerSubject);

    const execute = async (activeTx) => {
      return await activeTx.providerIdentities.resolve(normalizedProvider, validSubject);
    };

    if (tx) {
      return await execute(tx);
    }
    return await this.pgDriver.withTransaction(execute);
  }

  /**
   * Links an external provider identity to a V2 account.
   *
   * Rules:
   * - Validates provider against registry (GOOGLE, FACEBOOK, THREADS).
   * - Validates providerSubject as opaque non-empty string.
   * - Fails with AccountNotFoundError if target account does not exist.
   * - Fails with InvalidTrustedPrincipalError if target account state is not ACTIVE.
   * - If identity is already linked to the exact same account, returns existing identity (idempotent success, no duplicate event).
   * - If identity is already linked to another account, throws DuplicateProviderIdentityError.
   * - Maps 23505 PostgreSQL uniqueness violation ONLY when err.constraint strictly matches PROVIDER_IDENTITY_UNIQUE_CONSTRAINT.
   * - Emits identity.provider_linked domain event atomically inside active transaction.
   *
   * @param {Object} params
   * @param {string} params.userId - Target V2 account user_id
   * @param {string} params.provider - Provider string
   * @param {string} params.providerSubject - Provider stable account ID
   * @param {Object} [tx] - Optional active transaction handle
   * @returns {Promise<Object>} Linked provider identity record
   */
  async linkProviderIdentity({ userId, provider, providerSubject }, tx = null) {
    if (!userId || typeof userId !== 'string') {
      throw new AccountNotFoundError(userId);
    }

    const normalizedProvider = validateAndNormalizeProvider(provider);
    const validSubject = validateProviderSubject(providerSubject);

    const execute = async (activeTx) => {
      // 1. Verify target account exists and is ACTIVE
      const targetAccount = await activeTx.accounts.getById(userId);
      if (!targetAccount) {
        throw new AccountNotFoundError(userId);
      }
      if (targetAccount.state !== ACCOUNT_STATES.ACTIVE) {
        throw new InvalidTrustedPrincipalError(`Target account "${userId}" is in state "${targetAccount.state}" and cannot link provider identities.`);
      }

      // 2. Check if identity is already linked
      const existingLink = await activeTx.providerIdentities.resolve(normalizedProvider, validSubject);
      if (existingLink) {
        if (existingLink.userId === userId) {
          // Exact same provider identity linked to exact same account -> Idempotent success (no duplicate event)
          return existingLink;
        }
        // Identity belongs to another account -> throw DuplicateProviderIdentityError
        throw new DuplicateProviderIdentityError(normalizedProvider, validSubject);
      }

      // 3. Perform link insertion
      let linkRecord;
      try {
        linkRecord = await activeTx.providerIdentities.link({
          provider: normalizedProvider,
          providerSubject: validSubject,
          userId,
        });
      } catch (err) {
        // STRICT 23505 CONSTRAINT MAPPING
        if (err.code === '23505' && err.constraint === PROVIDER_IDENTITY_UNIQUE_CONSTRAINT) {
          throw new DuplicateProviderIdentityError(normalizedProvider, validSubject);
        }
        throw err;
      }

      // 4. Record outbox event atomically
      const event = createDomainEvent({
        eventType: EVENT_TYPES.PROVIDER_LINKED,
        aggregate: { type: 'account', id: userId },
        payload: {
          userId,
          provider: normalizedProvider,
          providerSubject: validSubject,
          linkedAt: linkRecord.linkedAt || new Date().toISOString(),
        },
      });
      activeTx.outbox.record(event);

      return linkRecord;
    };

    if (tx) {
      return await execute(tx);
    }
    return await this.pgDriver.withTransaction(execute);
  }

  /**
   * Application-layer use case linking a verified provider identity assertion to a trusted server principal.
   *
   * @param {Object} params
   * @param {TrustedPrincipal} params.principal - Server-established authenticated principal
   * @param {ProviderAssertion} params.providerAssertion - Verified provider identity assertion
   * @param {Object} [tx] - Optional active transaction handle
   * @returns {Promise<Object>} Linked provider identity record
   */
  async linkProviderForPrincipal({ principal, providerAssertion }, tx = null) {
    if (!principal || !(principal instanceof TrustedPrincipal)) {
      throw new InvalidTrustedPrincipalError();
    }

    if (!providerAssertion || !(providerAssertion instanceof ProviderAssertion) || !providerAssertion.isVerified) {
      throw new InvalidProviderAssertionError();
    }

    return await this.linkProviderIdentity({
      userId: principal.userId,
      provider: providerAssertion.provider,
      providerSubject: providerAssertion.providerSubject,
    }, tx);
  }

  /**
   * Verifies raw credential token using ProviderVerifierPort and links the verified assertion to the principal.
   *
   * @param {Object} params
   * @param {TrustedPrincipal} params.principal
   * @param {string} params.provider
   * @param {string} params.credential
   * @param {Object} params.verifier - Concrete ProviderVerifierPort implementation
   * @param {Object} [tx]
   * @returns {Promise<Object>} Linked provider identity record
   */
  async verifyAndLinkProvider({ principal, provider, credential, verifier }, tx = null) {
    if (!verifier || typeof verifier.verifyCredential !== 'function') {
      throw new ProviderVerificationRequiredError('Valid ProviderVerifierPort instance is required.');
    }

    const assertion = await verifier.verifyCredential({ provider, credential });
    return await this.linkProviderForPrincipal({ principal, providerAssertion: assertion }, tx);
  }
}
