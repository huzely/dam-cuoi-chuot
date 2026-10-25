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
import { QTV_ROLES, InvalidReasonError } from '../core/rbac.js';
import { createCommand } from '../core/command.js';
import {
  CONFIG_CATEGORIES,
  RulesetSnapshot,
  UnresolvedConfigError,
} from '../core/config.js';

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

test('Admin Shell: 5. Feature Flags Administration & Prerequisite Failure', async () => {
  const { adminService, prerequisiteRegistry, auditDriver } = setupAdminFixture();
  const superAdmin = { actorId: 'super_001', role: QTV_ROLES.SUPER_ADMIN };

  // Unknown flag rejected
  await assert.rejects(async () => {
    await adminService.executeAdminCommand({
      adminActor: superAdmin,
      command: createCommand({
        type: ADMIN_COMMAND_TYPES.FEATURE_FLAG_SET,
        actor: superAdmin,
        payload: { flagKey: 'NON_EXISTENT_FLAG', enabled: true, reason: 'Test' },
      }),
    });
  }, UnregisteredFlagError);

  // Feature with unresolved TBD_FROM_DATA prerequisite fails closed
  prerequisiteRegistry.registerPrerequisites('CARD_WAGER', ['CARD_STAKE_TIERS']);

  const snapshotWithTBD = new RulesetSnapshot('2.0.0-draft', {
    'CARD_STAKE_TIERS': {
      category: CONFIG_CATEGORIES.TBD_FROM_DATA,
      value: CONFIG_CATEGORIES.TBD_FROM_DATA,
    },
  });

  await assert.rejects(async () => {
    await adminService.executeAdminCommand({
      adminActor: superAdmin,
      command: createCommand({
        type: ADMIN_COMMAND_TYPES.FEATURE_FLAG_SET,
        actor: superAdmin,
        payload: {
          flagKey: 'CARD_WAGER',
          enabled: true,
          reason: 'Enabling card wagering',
          rulesetSnapshot: snapshotWithTBD,
        },
      }),
    });
  }, UnresolvedConfigError);

  // Successful flag set command produces audit log
  await adminService.executeAdminCommand({
    adminActor: superAdmin,
    command: createCommand({
      type: ADMIN_COMMAND_TYPES.FEATURE_FLAG_SET,
      actor: superAdmin,
      payload: { flagKey: 'HOI_XUAN_V2', enabled: true, reason: 'Enabling Hoi Xuan V2' },
    }),
  });

  const auditRecords = await auditDriver.getAuditRecords();
  assert.ok(auditRecords.length >= 1);
});

test('Admin Shell: 6. Config / Ruleset Administration & TBD Fail-Closed Approval', async () => {
  const { adminService } = setupAdminFixture();
  const econManager = { actorId: 'econ_001', role: QTV_ROLES.ECONOMY_MANAGER };

  // Create DRAFT config succeeds
  const draftRes = await adminService.executeAdminCommand({
    adminActor: econManager,
    command: createCommand({
      type: ADMIN_COMMAND_TYPES.CONFIG_CREATE_DRAFT,
      actor: econManager,
      payload: {
        version: '2.0.0',
        definitions: { 'MIN_STAKE': { category: CONFIG_CATEGORIES.ECONOMY_CONFIG, value: 50 } },
        reason: 'Creating draft ruleset for V2',
      },
    }),
  });
  assert.equal(draftRes.status, 'DRAFT');

  // Approving config containing unresolved TBD_FROM_DATA fails closed
  const snapshotUnresolved = new RulesetSnapshot('2.0.0-unresolved', {
    'UNRESOLVED_FEE': {
      category: CONFIG_CATEGORIES.TBD_FROM_DATA,
      value: CONFIG_CATEGORIES.TBD_FROM_DATA,
    },
  });

  await assert.rejects(async () => {
    await adminService.executeAdminCommand({
      adminActor: econManager,
      command: createCommand({
        type: ADMIN_COMMAND_TYPES.CONFIG_APPROVE,
        actor: econManager,
        payload: {
          version: '2.0.0-unresolved',
          snapshot: snapshotUnresolved,
          reason: 'Attempting approval',
        },
      }),
    });
  }, UnresolvedConfigError);
});

test('Admin Shell: 7. Kill Switch Administration', async () => {
  const { adminService, killSwitchService } = setupAdminFixture();
  const secReviewer = { actorId: 'sec_001', role: QTV_ROLES.SECURITY_REVIEWER };

  // Enable kill switch for card wagering
  const res = await adminService.executeAdminCommand({
    adminActor: secReviewer,
    command: createCommand({
      type: ADMIN_COMMAND_TYPES.KILL_SWITCH_SET,
      actor: secReviewer,
      payload: {
        switchKey: 'KILL_SWITCH_CARD_WAGER',
        active: true,
        reason: 'Emergency security investigation',
      },
    }),
  });

  assert.equal(res.success, true);
  const active = await killSwitchService.isKillSwitchActive('KILL_SWITCH_CARD_WAGER');
  assert.equal(active, true);
});

test('Admin Shell: 8. Audit Logging Security & Secret Stripping', async () => {
  const { adminService, auditDriver } = setupAdminFixture();
  const superAdmin = { actorId: 'super_001', role: QTV_ROLES.SUPER_ADMIN };

  try {
    await adminService.executeAdminCommand({
      adminActor: superAdmin,
      command: createCommand({
        type: ADMIN_COMMAND_TYPES.FEATURE_FLAG_SET,
        actor: superAdmin,
        payload: {
          flagKey: 'ACCOUNT_V2',
          enabled: true,
          reason: 'Testing audit secrets redacting',
          apiKey: 'secret_api_key_12345', // Secret field!
          nested: { password: 'my_password_xyz' }, // Nested secret field!
        },
      }),
    });
  } catch (err) {
    console.error('DEBUG TEST 8 ERROR:', err);
    throw err;
  }

  const records = await auditDriver.getAuditRecords();
  assert.equal(records.length, 1);
  const audit = records[0];

  assert.equal(audit.adminActorId, 'super_001');
  assert.equal(audit.adminRole, 'SUPER_ADMIN');
  // Secrets must be redacted in audit metadata
  assert.equal(audit.metadata.apiKey, '[REDACTED]');
  assert.equal(audit.metadata.nested.password, '[REDACTED]');
});
