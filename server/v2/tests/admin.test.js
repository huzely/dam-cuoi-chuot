import test from 'node:test';
import assert from 'node:assert/strict';
import {
  AdminService,
  ADMIN_COMMAND_TYPES,
} from '../domains/admin/service.js';
import { KillSwitchService } from '../domains/admin/kill-switch.js';
import { FeaturePrerequisiteRegistry } from '../domains/admin/prerequisites.js';
import {
  PgFeatureFlagRepository,
  MemoryFeatureFlagDriver,
  UnregisteredFlagError,
} from '../adapters/pg-feature-flags.js';
import {
  PgConfigRepository,
  MemoryConfigDriver,
} from '../adapters/pg-config.js';
import {
  PgAdminAuditLogger,
  MemoryAuditDriver,
} from '../adapters/pg-audit.js';
import {
  PgTransactionAdapter,
  MemoryTransactionDriver,
} from '../adapters/pg-transaction.js';
import { QTV_ROLES, InvalidReasonError } from '../core/rbac.js';
import { createCommand } from '../core/command.js';
import { CONFIG_CATEGORIES, UnresolvedConfigError, RulesetSnapshot } from '../core/config.js';

function setupAdminFixture() {
  const flagDriver = new MemoryFeatureFlagDriver();
  const flagRepo = new PgFeatureFlagRepository(flagDriver);

  const configDriver = new MemoryConfigDriver();
  const configRepo = new PgConfigRepository(configDriver);

  const killSwitchService = new KillSwitchService();
  const prerequisiteRegistry = new FeaturePrerequisiteRegistry();

  const auditDriver = new MemoryAuditDriver();
  const auditLogger = new PgAdminAuditLogger(auditDriver);

  const adminService = new AdminService({
    featureFlagRepo: flagRepo,
    configRepo: configRepo,
    killSwitchService,
    prerequisiteRegistry,
    auditLogger,
  });

  return {
    adminService,
    flagRepo,
    configRepo,
    killSwitchService,
    prerequisiteRegistry,
    auditDriver,
  };
}

test('Admin Shell: 1. Trusted Actor & Payload Spoofing Rejection', async () => {
  const { adminService } = setupAdminFixture();

  // Missing trusted admin actor rejected
  await assert.rejects(async () => {
    await adminService.executeAdminCommand({
      adminActor: null,
      command: { type: ADMIN_COMMAND_TYPES.FEATURE_FLAG_SET },
    });
  }, /Security Error: Trusted admin actor/);

  // Payload attempting to spoof admin actor/role rejected
  const trustedAdmin = { actorId: 'admin_real', role: QTV_ROLES.SUPER_ADMIN };
  await assert.rejects(async () => {
    await adminService.executeAdminCommand({
      adminActor: trustedAdmin,
      command: createCommand({
        type: ADMIN_COMMAND_TYPES.FEATURE_FLAG_SET,
        actor: trustedAdmin,
        payload: {
          flagKey: 'ACCOUNT_V2',
          enabled: true,
          reason: 'Valid reason',
          adminActorId: 'admin_imposter', // Spoofing attempt
        },
      }),
    });
  }, /Security Error: Admin command payload must not dictate admin actor identity/);
});

test('Admin Shell: 2. RBAC Permission Matrix & Separation of Duties', async () => {
  const { adminService } = setupAdminFixture();

  const modActor = { actorId: 'mod_001', role: QTV_ROLES.MODERATOR };
  const secActor = { actorId: 'sec_001', role: QTV_ROLES.SECURITY_REVIEWER };

  // MODERATOR attempting feature flag management rejected
  await assert.rejects(async () => {
    await adminService.executeAdminCommand({
      adminActor: modActor,
      command: createCommand({
        type: ADMIN_COMMAND_TYPES.FEATURE_FLAG_SET,
        actor: modActor,
        payload: { flagKey: 'ACCOUNT_V2', enabled: true, reason: 'Enabling feature' },
      }),
    });
  }, /Permission Denied: Role "MODERATOR" lacks permission "feature_flags.manage"/);

  // SECURITY_REVIEWER attempting config draft creation rejected
  await assert.rejects(async () => {
    await adminService.executeAdminCommand({
      adminActor: secActor,
      command: createCommand({
        type: ADMIN_COMMAND_TYPES.CONFIG_CREATE_DRAFT,
        actor: secActor,
        payload: { version: '2.0.0', definitions: {}, reason: 'Drafting config' },
      }),
    });
  }, /Permission Denied: Role "SECURITY_REVIEWER" lacks permission "config.draft"/);
});

test('Admin Shell: 3. Rejects Generic DB Mutations and Direct Money Modifications', async () => {
  const { adminService } = setupAdminFixture();
  const superAdmin = { actorId: 'super_001', role: QTV_ROLES.SUPER_ADMIN };

  const forbiddenCommands = [
    'admin.sql.execute',
    'admin.table.update',
    'admin.database.write',
    'admin.money.set',
    'admin.wallet.setBalance',
  ];

  for (const cmdType of forbiddenCommands) {
    await assert.rejects(async () => {
      await adminService.executeAdminCommand({
        adminActor: superAdmin,
        command: { type: cmdType, payload: { reason: 'Generic write' } },
      });
    }, /Forbidden Admin Command/);
  }
});

test('Admin Shell: 4. Reason Enforcement for Sensitive Operations', async () => {
  const { adminService } = setupAdminFixture();
  const superAdmin = { actorId: 'super_001', role: QTV_ROLES.SUPER_ADMIN };

  // Empty reason rejected
  await assert.rejects(async () => {
    await adminService.executeAdminCommand({
      adminActor: superAdmin,
      command: createCommand({
        type: ADMIN_COMMAND_TYPES.FEATURE_FLAG_SET,
        actor: superAdmin,
        payload: { flagKey: 'ACCOUNT_V2', enabled: true, reason: '   ' }, // Whitespace only!
      }),
    });
  }, InvalidReasonError);

  // Valid reason succeeds
  const res = await adminService.executeAdminCommand({
    adminActor: superAdmin,
    command: createCommand({
      type: ADMIN_COMMAND_TYPES.FEATURE_FLAG_SET,
      actor: superAdmin,
      payload: { flagKey: 'ACCOUNT_V2', enabled: true, reason: 'Approved V2 Account Rollout' },
    }),
  });
  assert.equal(res.success, true);
});

test('Admin Shell Atomic Rollback 1: Feature flag mutation rolls back when audit persistence fails', async () => {
  const { adminService, flagRepo } = setupAdminFixture();
  const superAdmin = { actorId: 'super_001', role: QTV_ROLES.SUPER_ADMIN };

  // Setup transaction driver configured to fail during audit recording
  const txDriver = new MemoryTransactionDriver();
  txDriver.recordMutation = async (mutation) => {
    if (mutation.table === 'v2_admin_audit_logs') {
      throw new Error('Audit table database disk full failure');
    }
    txDriver.mutations.push(mutation);
  };
  const txAdapter = new PgTransactionAdapter(txDriver);

  await assert.rejects(async () => {
    await adminService.executeAdminCommand({
      adminActor: superAdmin,
      command: createCommand({
        type: ADMIN_COMMAND_TYPES.FEATURE_FLAG_SET,
        actor: superAdmin,
        payload: { flagKey: 'ACCOUNT_V2', enabled: true, reason: 'Testing atomic rollback' },
      }),
      txAdapter,
    });
  }, /Audit table database disk full failure/);

  // Assert transaction rolled back and flag state was not committed
  assert.equal(txDriver.committed, false);
  assert.equal(txDriver.rolledBack, true);
  assert.equal(await flagRepo.isEnabled('ACCOUNT_V2'), false);
});

test('Admin Shell Atomic Rollback 2: Config approval rolls back when audit persistence fails', async () => {
  const { adminService, configRepo } = setupAdminFixture();
  const econManager = { actorId: 'econ_001', role: QTV_ROLES.ECONOMY_MANAGER };

  // Create valid draft config
  await configRepo.db.saveRuleset('2.0.0-atomic', 'DRAFT', {
    'STAKE': { category: CONFIG_CATEGORIES.ECONOMY_CONFIG, value: 100 },
  });

  const txDriver = new MemoryTransactionDriver();
  txDriver.recordMutation = async (mutation) => {
    if (mutation.table === 'v2_admin_audit_logs') {
      throw new Error('Audit DB write error');
    }
    txDriver.mutations.push(mutation);
  };
  const txAdapter = new PgTransactionAdapter(txDriver);

  await assert.rejects(async () => {
    await adminService.executeAdminCommand({
      adminActor: econManager,
      command: createCommand({
        type: ADMIN_COMMAND_TYPES.CONFIG_APPROVE,
        actor: econManager,
        payload: { version: '2.0.0-atomic', reason: 'Approving ruleset' },
      }),
      txAdapter,
    });
  }, /Audit DB write error/);

  // Assert draft ruleset remained DRAFT and was not committed as APPROVED
  const rec = await configRepo.db.getRulesetByVersion('2.0.0-atomic');
  assert.equal(rec.status, 'DRAFT');
});

test('Admin Shell Atomic Rollback 3: Kill switch mutation rolls back when audit persistence fails', async () => {
  const { adminService, killSwitchService } = setupAdminFixture();
  const secReviewer = { actorId: 'sec_001', role: QTV_ROLES.SECURITY_REVIEWER };

  const txDriver = new MemoryTransactionDriver();
  txDriver.recordMutation = async (mutation) => {
    if (mutation.table === 'v2_admin_audit_logs') {
      throw new Error('Audit table write error');
    }
    txDriver.mutations.push(mutation);
  };
  const txAdapter = new PgTransactionAdapter(txDriver);

  await assert.rejects(async () => {
    await adminService.executeAdminCommand({
      adminActor: secReviewer,
      command: createCommand({
        type: ADMIN_COMMAND_TYPES.KILL_SWITCH_SET,
        actor: secReviewer,
        payload: { switchKey: 'KILL_SWITCH_TEST', active: true, reason: 'Emergency test' },
      }),
      txAdapter,
    });
  }, /Audit table write error/);

  assert.equal(await killSwitchService.isKillSwitchActive('KILL_SWITCH_TEST'), false);
});

test('Admin Shell Server-Side Config Approval: 4 & 5. Omitted or forged client snapshot cannot approve unresolved persisted config', async () => {
  const { adminService, configRepo } = setupAdminFixture();
  const econManager = { actorId: 'econ_001', role: QTV_ROLES.ECONOMY_MANAGER };

  // Save DRAFT ruleset containing TBD_FROM_DATA in database
  await configRepo.db.saveRuleset('2.0.0-tbd', 'DRAFT', {
    'THEFT_CAP': {
      category: CONFIG_CATEGORIES.TBD_FROM_DATA,
      value: CONFIG_CATEGORIES.TBD_FROM_DATA,
    },
  });

  // 1. Omitted client snapshot in payload MUST NOT bypass TBD validation
  await assert.rejects(async () => {
    await adminService.executeAdminCommand({
      adminActor: econManager,
      command: createCommand({
        type: ADMIN_COMMAND_TYPES.CONFIG_APPROVE,
        actor: econManager,
        payload: { version: '2.0.0-tbd', reason: 'Approving without snapshot in payload' },
      }),
    });
  }, UnresolvedConfigError);

  // 2. Forged client snapshot in payload attempting to substitute resolved values MUST BE IGNORED
  const forgedSnapshotPayload = {
    version: '2.0.0-tbd',
    reason: 'Attempting approval with fake payload snapshot',
    snapshot: new RulesetSnapshot('2.0.0-tbd', {
      'THEFT_CAP': { category: CONFIG_CATEGORIES.ECONOMY_CONFIG, value: 9999 }, // Fake resolved value in payload!
    }),
  };

  await assert.rejects(async () => {
    await adminService.executeAdminCommand({
      adminActor: econManager,
      command: createCommand({
        type: ADMIN_COMMAND_TYPES.CONFIG_APPROVE,
        actor: econManager,
        payload: forgedSnapshotPayload,
      }),
    });
  }, UnresolvedConfigError);

  // Assert draft ruleset in DB remains DRAFT
  const draftRec = await configRepo.db.getRulesetByVersion('2.0.0-tbd');
  assert.equal(draftRec.status, 'DRAFT');
});

test('Admin Shell Server-Driven Prerequisites: 6. Feature prerequisite validation cannot be bypassed by omitting payload config', async () => {
  const { adminService, prerequisiteRegistry, configRepo } = setupAdminFixture();
  const superAdmin = { actorId: 'super_001', role: QTV_ROLES.SUPER_ADMIN };

  // Register prerequisite
  prerequisiteRegistry.registerPrerequisites('CARD_WAGER', ['CARD_STAKE_TIERS']);

  // Save approved ruleset with TBD parameter in DB
  await configRepo.db.saveRuleset('1.0.0', 'APPROVED', {
    'CARD_STAKE_TIERS': {
      category: CONFIG_CATEGORIES.TBD_FROM_DATA,
      value: CONFIG_CATEGORIES.TBD_FROM_DATA,
    },
  });

  // Client attempts to enable flag without providing snapshot payload field
  await assert.rejects(async () => {
    await adminService.executeAdminCommand({
      adminActor: superAdmin,
      command: createCommand({
        type: ADMIN_COMMAND_TYPES.FEATURE_FLAG_SET,
        actor: superAdmin,
        payload: { flagKey: 'CARD_WAGER', enabled: true, reason: 'Enabling without payload snapshot' },
      }),
    });
  }, UnresolvedConfigError);
});

test('Admin Shell Audit Integrity: 7. Successful admin mutation produces exactly one durable audit record with secret stripping', async () => {
  const { adminService, auditDriver } = setupAdminFixture();
  const superAdmin = { actorId: 'super_001', role: QTV_ROLES.SUPER_ADMIN };

  const res = await adminService.executeAdminCommand({
    adminActor: superAdmin,
    command: createCommand({
      type: ADMIN_COMMAND_TYPES.FEATURE_FLAG_SET,
      actor: superAdmin,
      payload: {
        flagKey: 'ACCOUNT_V2',
        enabled: true,
        reason: 'Rollout ACCOUNT_V2',
        apiKey: 'super_secret_api_key',
      },
    }),
  });

  assert.equal(res.success, true);
  const auditRecords = await auditDriver.getAuditRecords();
  assert.equal(auditRecords.length, 1);
  assert.equal(auditRecords[0].adminActorId, 'super_001');
  assert.equal(auditRecords[0].metadata.apiKey, '[REDACTED]');
});
