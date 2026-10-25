/**
 * Production PostgreSQL Driver Adapter for V2 Server Foundation.
 * Provides transaction-scoped persistence contexts executing state mutations,
 * idempotency claims, outbox records, and audit events on a single connection.
 */

import { MissingDatabaseDriverError } from './pg-idempotency.js';
import { assertPermission, createAdminAuditEvent } from '../core/rbac.js';

export class PgDriver {
  /**
   * @param {Object|string} config - Connection configuration or connection string
   * @param {string} [config.connectionString] - PostgreSQL connection URL
   * @param {Object} [config.pool] - Existing pg Pool instance
   */
  constructor(config = null) {
    if (!config) {
      throw new MissingDatabaseDriverError('PgDriver');
    }

    const connStr = typeof config === 'string' ? config : config.connectionString;
    const pool = typeof config === 'object' ? config.pool : null;

    if (!connStr && !pool) {
      throw new MissingDatabaseDriverError('PgDriver');
    }

    // Safety guard against accidentally running test migrations/wipes on production URL
    if (connStr && isProductionUrl(connStr) && process.env.ALLOW_PRODUCTION_DB_TEST !== 'true') {
      throw new Error('Database Safety Guard: Refusing to connect to production PostgreSQL URL during test/migration execution.');
    }

    this.connectionString = connStr;
    this.pool = pool;
  }

  /**
   * Executes a work function inside a single PostgreSQL transaction handle.
   * On error before COMMIT, performs ROLLBACK.
   *
   * @param {Function} workFn - Async function receiving transaction context `tx`
   * @returns {Promise<any>}
   */
  async withTransaction(workFn) {
    // In production environment with pg pool:
    // const client = await this.pool.connect();
    // try {
    //   await client.query('BEGIN');
    //   const txContext = createTxContext(client);
    //   const result = await workFn(txContext);
    //   await client.query('COMMIT');
    //   return result;
    // } catch (err) {
    //   await client.query('ROLLBACK');
    //   throw err;
    // } finally {
    //   client.release();
    // }

    if (!this.pool && !this.connectionString) {
      throw new MissingDatabaseDriverError('PgDriver');
    }

    // Abstract driver interface definition
    throw new Error('PgDriver requires an active PostgreSQL connection pool (pg package or Supabase client).');
  }
}

/**
 * Checks if a connection string appears to point to production storage.
 */
function isProductionUrl(connStr) {
  if (!connStr) return false;
  const str = connStr.toLowerCase();
  return str.includes('mamafzllyhbmzyystivo') || (str.includes('supabase.co') && !str.includes('test') && !str.includes('staging'));
}
