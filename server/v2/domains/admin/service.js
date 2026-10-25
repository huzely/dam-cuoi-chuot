/**
 * V2 Admin / Operations Service & Execution Pipeline.
 * Enforces trusted admin actor context, RBAC authorization, reason requirements,
 * domain validation, and mandatory sanitized audit logging.
 */

import {
  QTV_ROLES,
  ADMIN_PERMISSIONS,
  assertPermission,
  assertReason,
} from '../../core/rbac.js';
import { UnregisteredFlagError } from '../../adapters/pg-feature-flags.js';
import { FEATURE_FLAGS } from '../../core/feature-flags.js';

export const ADMIN_COMMAND_TYPES = Object.freeze({
  FEATURE_FLAG_SET: 'admin.feature_flag.set',
  CONFIG_CREATE_DRAFT: 'admin.config.create_draft',
  CONFIG_APPROVE: 'admin.config.approve',
  KILL_SWITCH_SET: 'admin.kill_switch.set',
  SECURITY_REVIEW_CASE: 'admin.security.review_case',
});

const FORBIDDEN_ADMIN_COMMANDS = new Set([
  'admin.sql.execute',
  'admin.table.update',
  'admin.database.write',
  'admin.money.set',
  'admin.wallet.setBalance',
]);

export class AdminService {
  /**
   * @param {Object} params
   * @param {Object} [params.featureFlagRepo]
   * @param {Object} [params.configRepo]
   * @param {Object} [params.killSwitchService]
   * @param {Object} [params.prerequisiteRegistry]
   * @param {Object} [params.auditLogger]
   */
  constructor({
    featureFlagRepo,
    configRepo,
    killSwitchService,
    prerequisiteRegistry = null,
    auditLogger,
  }) {
    this.featureFlagRepo = featureFlagRepo;
    this.configRepo = configRepo;
    this.killSwitchService = killSwitchService;
    this.prerequisiteRegistry = prerequisiteRegistry;
    this.auditLogger = auditLogger;
  }

  /**
   * Executes a semantic admin command through the authorization and audit pipeline.
   *
   * @param {Object} params
   * @param {Object} params.adminActor - Trusted admin actor from server context { actorId, role }
   * @param {Object} params.command - Semantic admin command { type, payload }
   * @returns {Promise<Object>} Execution result
   */
  async executeAdminCommand({ adminActor, command }) {
    if (!adminActor || !adminActor.actorId || !adminActor.role) {
      throw new Error('Security Error: Trusted admin actor with actorId and role is required.');
    }

    if (!Object.values(QTV_ROLES).includes(adminActor.role)) {
      throw new Error(`Security Error: Invalid QTV role "${adminActor.role}".`);
    }

    if (!command || !command.type) {
      throw new Error('Valid semantic admin command object required.');
    }

    // Security check: Payload must not spoof admin identity
    const payload = command.payload || {};
    if (payload.adminActorId || payload.adminRole || payload.role || payload.permissions || payload.isAdmin !== undefined) {
      throw new Error('Security Error: Admin command payload must not dictate admin actor identity, role, or permissions.');
    }

    if (FORBIDDEN_ADMIN_COMMANDS.has(command.type)) {
      throw new Error(`Forbidden Admin Command: "${command.type}" violates semantic domain invariants. Direct database/money overrides are prohibited.`);
    }

    switch (command.type) {
      case ADMIN_COMMAND_TYPES.FEATURE_FLAG_SET:
        return await this._handleFeatureFlagSet(adminActor, command, payload);

      case ADMIN_COMMAND_TYPES.CONFIG_CREATE_DRAFT:
        return await this._handleConfigCreateDraft(adminActor, command, payload);

      case ADMIN_COMMAND_TYPES.CONFIG_APPROVE:
        return await this._handleConfigApprove(adminActor, command, payload);

      case ADMIN_COMMAND_TYPES.KILL_SWITCH_SET:
        return await this._handleKillSwitchSet(adminActor, command, payload);

      case ADMIN_COMMAND_TYPES.SECURITY_REVIEW_CASE:
        return await this._handleSecurityReviewCase(adminActor, command, payload);

      default:
        throw new Error(`Unknown admin command type: "${command.type}".`);
    }
  }

  async _handleFeatureFlagSet(adminActor, command, payload) {
    assertPermission(adminActor.role, ADMIN_PERMISSIONS.FEATURE_FLAGS_MANAGE);
    assertReason(payload.reason);

    const { flagKey, enabled } = payload;
    if (!Object.values(FEATURE_FLAGS).includes(flagKey)) {
      throw new UnregisteredFlagError(flagKey);
    }

    // Check prerequisites if enabling
    if (enabled && this.prerequisiteRegistry && payload.rulesetSnapshot) {
      this.prerequisiteRegistry.checkPrerequisites(flagKey, payload.rulesetSnapshot);
    }

    if (this.featureFlagRepo && this.featureFlagRepo.db) {
      await this.featureFlagRepo.db.setFlag(flagKey, Boolean(enabled));
    }

    await this.auditLogger.logAuditEvent({
      adminActor,
      action: ADMIN_PERMISSIONS.FEATURE_FLAGS_MANAGE,
      targetRef: { type: 'feature_flag', id: flagKey },
      reason: payload.reason,
      commandId: command.commandId,
      metadata: { ...payload, flagKey, enabled: Boolean(enabled) },
    });

    return { success: true, flagKey, enabled: Boolean(enabled) };
  }

  async _handleConfigCreateDraft(adminActor, command, payload) {
    assertPermission(adminActor.role, ADMIN_PERMISSIONS.CONFIG_DRAFT);
    assertReason(payload.reason);

    const { version, definitions } = payload;
    if (!version || typeof version !== 'string') {
      throw new Error('Config version string required.');
    }

    if (this.configRepo && this.configRepo.db) {
      await this.configRepo.db.saveRuleset(version, 'DRAFT', definitions || {});
    }

    await this.auditLogger.logAuditEvent({
      adminActor,
      action: ADMIN_PERMISSIONS.CONFIG_DRAFT,
      targetRef: { type: 'config_ruleset', id: version },
      reason: payload.reason,
      commandId: command.commandId,
      metadata: { ...payload, version, status: 'DRAFT' },
    });

    return { success: true, version, status: 'DRAFT' };
  }

  async _handleConfigApprove(adminActor, command, payload) {
    assertPermission(adminActor.role, ADMIN_PERMISSIONS.CONFIG_APPROVE);
    assertReason(payload.reason);

    const { version, snapshot } = payload;
    if (!version || typeof version !== 'string') {
      throw new Error('Config version string required.');
    }

    // Fail closed if snapshot contains TBD_FROM_DATA parameters
    if (snapshot) {
      snapshot.validateAllResolved();
    }

    if (this.configRepo && this.configRepo.db) {
      const existing = await this.configRepo.db.getRulesetByVersion(version);
      if (existing) {
        await this.configRepo.db.saveRuleset(version, 'APPROVED', existing.definitions);
      }
    }

    await this.auditLogger.logAuditEvent({
      adminActor,
      action: ADMIN_PERMISSIONS.CONFIG_APPROVE,
      targetRef: { type: 'config_ruleset', id: version },
      reason: payload.reason,
      commandId: command.commandId,
      metadata: { ...payload, version, status: 'APPROVED' },
    });

    return { success: true, version, status: 'APPROVED' };
  }

  async _handleKillSwitchSet(adminActor, command, payload) {
    assertPermission(adminActor.role, ADMIN_PERMISSIONS.KILL_SWITCH_MANAGE);
    assertReason(payload.reason);

    const { switchKey, active } = payload;
    if (!switchKey || typeof switchKey !== 'string') {
      throw new Error('Kill switchKey is required.');
    }

    if (this.killSwitchService) {
      await this.killSwitchService.setKillSwitch(switchKey, Boolean(active));
    }

    await this.auditLogger.logAuditEvent({
      adminActor,
      action: ADMIN_PERMISSIONS.KILL_SWITCH_MANAGE,
      targetRef: { type: 'kill_switch', id: switchKey },
      reason: payload.reason,
      commandId: command.commandId,
      metadata: { ...payload, switchKey, active: Boolean(active) },
    });

    return { success: true, switchKey, active: Boolean(active) };
  }

  async _handleSecurityReviewCase(adminActor, command, payload) {
    assertPermission(adminActor.role, ADMIN_PERMISSIONS.SECURITY_REVIEW);
    assertReason(payload.reason);

    const { caseId, outcome } = payload;
    if (!caseId || typeof caseId !== 'string') {
      throw new Error('Security caseId is required.');
    }

    await this.auditLogger.logAuditEvent({
      adminActor,
      action: ADMIN_PERMISSIONS.SECURITY_REVIEW,
      targetRef: { type: 'security_case', id: caseId },
      reason: payload.reason,
      commandId: command.commandId,
      metadata: { ...payload, caseId, outcome },
    });

    return { success: true, caseId, outcome };
  }
}
