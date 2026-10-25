/**
 * Production PostgreSQL Driver Adapter for V2 Server Foundation.
 * Provides transaction-scoped persistence contexts executing state mutations,
 * idempotency claims, outbox records, and audit events on a single PostgreSQL connection.
 */

import pg from 'pg';
import { MissingDatabaseDriverError, computeCanonicalFingerprint } from './pg-idempotency.js';
import { IdempotencyMismatchError, ConcurrentExecutionError } from '../core/idempotency.js';
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

    const connStr = typeof config === 'string' ? config : config?.connectionString;
    const pool = typeof config === 'object' ? config?.pool : null;

    if (!connStr && !pool) {
      throw new MissingDatabaseDriverError('PgDriver');
    }

    // Safety guard against accidentally running test migrations/wipes on production URL
    if (connStr && isProductionUrl(connStr) && process.env.ALLOW_PRODUCTION_DB_TEST !== 'true') {
      throw new Error('Database Safety Guard: Refusing to connect to production PostgreSQL URL during test/migration execution.');
    }

    this.connectionString = connStr;
    this.pool = pool || new pg.Pool({ connectionString: connStr });
  }

  /**
   * Executes a work function inside a single PostgreSQL transaction handle.
   * On error before COMMIT, performs ROLLBACK.
   *
   * @param {Function} workFn - Async function receiving transaction context `tx`
   * @returns {Promise<any>}
   */
  async withTransaction(workFn) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const txContext = new PgTxContext(client);
      const result = await workFn(txContext);
      await client.query('COMMIT');
      return result;
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  async close() {
    if (this.pool) {
      await this.pool.end();
    }
  }
}

/**
 * Transaction-scoped PostgreSQL persistence handle providing semantic domain operations.
 */
export class PgTxContext {
  constructor(client) {
    this.client = client;

    this.featureFlags = {
      set: async (flagKey, enabled) => {
        await this.client.query(
          `INSERT INTO public.v2_feature_flags (flag_key, enabled, updated_at)
           VALUES ($1, $2, NOW())
           ON CONFLICT (flag_key) DO UPDATE SET enabled = EXCLUDED.enabled, updated_at = NOW()`,
          [flagKey, Boolean(enabled)]
        );
      },
      get: async (flagKey) => {
        const res = await this.client.query(
          `SELECT enabled FROM public.v2_feature_flags WHERE flag_key = $1`,
          [flagKey]
        );
        return res.rows.length > 0 ? Boolean(res.rows[0].enabled) : false;
      },
    };

    this.config = {
      saveRuleset: async (version, status, definitions) => {
        await this.client.query(
          `INSERT INTO public.v2_config_rulesets (version, status, definitions, created_at)
           VALUES ($1, $2, $3::jsonb, NOW())
           ON CONFLICT (version) DO UPDATE SET status = EXCLUDED.status, definitions = EXCLUDED.definitions`,
          [version, status, JSON.stringify(definitions || {})]
        );
      },
      getRulesetByVersion: async (version) => {
        const res = await this.client.query(
          `SELECT version, status, definitions FROM public.v2_config_rulesets WHERE version = $1`,
          [version]
        );
        return res.rows.length > 0 ? res.rows[0] : null;
      },
    };

    this.killSwitch = {
      setKillSwitch: async (switchKey, active) => {
        await this.client.query(
          `INSERT INTO public.v2_feature_flags (flag_key, enabled, description, updated_at)
           VALUES ($1, $2, 'Kill Switch', NOW())
           ON CONFLICT (flag_key) DO UPDATE SET enabled = EXCLUDED.enabled, updated_at = NOW()`,
          [switchKey, Boolean(active)]
        );
      },
      isKillSwitchActive: async (switchKey) => {
        const res = await this.client.query(
          `SELECT enabled FROM public.v2_feature_flags WHERE flag_key = $1`,
          [switchKey]
        );
        return res.rows.length > 0 ? Boolean(res.rows[0].enabled) : false;
      },
    };

    this.idempotency = {
      claim: async (key, command) => {
        const actorId = command.actor.actorId;
        const fingerprint = computeCanonicalFingerprint(command.type, command.payload);

        const sel = await this.client.query(
          `SELECT status, command_type, request_fingerprint, result, error
           FROM public.v2_idempotency WHERE actor_id = $1 AND key = $2 FOR UPDATE`,
          [actorId, key]
        );

        if (sel.rows.length === 0) {
          await this.client.query(
            `INSERT INTO public.v2_idempotency (actor_id, key, command_type, request_fingerprint, status)
             VALUES ($1, $2, $3, $4, 'PENDING')`,
            [actorId, key, command.type, fingerprint]
          );
          return { status: 'CLAIMED' };
        }

        const existing = sel.rows[0];

        if (existing.command_type !== command.type || existing.request_fingerprint !== fingerprint) {
          throw new IdempotencyMismatchError(`Idempotency key "${key}" for actor "${actorId}" used for different request.`);
        }

        if (existing.status === 'PENDING') {
          throw new ConcurrentExecutionError(`Execution for key "${key}" is currently in progress.`);
        }

        if (existing.status === 'COMPLETED') {
          return { status: 'COMPLETED', result: existing.result };
        }

        if (existing.status === 'FAILED') {
          await this.client.query(
            `UPDATE public.v2_idempotency SET status = 'PENDING', error = NULL, updated_at = NOW()
             WHERE actor_id = $1 AND key = $2`,
            [actorId, key]
          );
          return { status: 'CLAIMED', previousError: existing.error };
        }

        throw new Error(`Unknown idempotency state "${existing.status}"`);
      },
      complete: async (actorId, key, result) => {
        await this.client.query(
          `UPDATE public.v2_idempotency SET status = 'COMPLETED', result = $3::jsonb, completed_at = NOW(), updated_at = NOW()
           WHERE actor_id = $1 AND key = $2`,
          [actorId, key, JSON.stringify(result || {})]
        );
      },
      fail: async (actorId, key, error) => {
        const errObj = error instanceof Error ? { message: error.message, code: error.code } : error;
        await this.client.query(
          `UPDATE public.v2_idempotency SET status = 'FAILED', error = $3::jsonb, failed_at = NOW(), updated_at = NOW()
           WHERE actor_id = $1 AND key = $2`,
          [actorId, key, JSON.stringify(errObj || {})]
        );
      },
    };

    this.outbox = {
      record: async (domainEvent) => {
        await this.client.query(
          `INSERT INTO public.v2_outbox (event_id, event_type, aggregate_type, aggregate_id, actor_id, schema_version, payload, occurred_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8)`,
          [
            domainEvent.eventId,
            domainEvent.eventType,
            domainEvent.aggregate.type,
            domainEvent.aggregate.id,
            domainEvent.actor?.actorId || null,
            domainEvent.schemaVersion || '1.0.0',
            JSON.stringify(domainEvent.payload || {}),
            domainEvent.occurredAt || new Date().toISOString(),
          ]
        );
      },
    };

    this.audit = {
      logAuditEvent: async ({ adminActor, action, targetRef, reason, commandId, metadata }) => {
        assertPermission(adminActor.role, action);
        const auditRecord = createAdminAuditEvent({
          adminActor,
          action,
          targetRef,
          reason,
          commandId,
          metadata,
        });

        await this.client.query(
          `INSERT INTO public.v2_admin_audit_logs (event_id, admin_actor_id, admin_role, action, target_ref, reason, command_id, created_at)
           VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, NOW())`,
          [
            auditRecord.eventId,
            auditRecord.adminActor.actorId,
            auditRecord.adminActor.role,
            auditRecord.action,
            JSON.stringify(auditRecord.targetRef || {}),
            auditRecord.reason,
            commandId || null,
          ]
        );

        return auditRecord;
      },
    };
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
