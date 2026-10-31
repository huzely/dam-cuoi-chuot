import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  AdminService,
  ADMIN_COMMAND_TYPES,
} from '../domains/admin/service.js';
import { FeaturePrerequisiteRegistry } from '../domains/admin/prerequisites.js';
import {
  MemoryAdminPersistence,
} from '../adapters/pg-admin-persistence.js';
import { MissingDatabaseDriverError } from '../adapters/pg-idempotency.js';
import { UnregisteredFlagError } from '../adapters/pg-feature-flags.js';
import { QTV_ROLES, InvalidReasonError } from '../core/rbac.js';
import { createCommand } from '../core/command.js';
import { CONFIG_CATEGORIES, UnresolvedConfigError, RulesetSnapshot } from '../core/config.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function setupAdminFixture() {
  const adminPersistence = new MemoryAdminPersistence();
  const prerequisiteRegistry = new FeaturePrerequisiteRegistry();

  const adminService = new AdminService({
    adminPersistence,
    prerequisiteRegistry,
  });

  return {
    adminService,
    adminPersistence,
    prerequisiteRegistry,
  };
}

test('Admin Shell: 1. Fail Fast without explicit adminPersistence', () => {
  assert.throws(() => new AdminService({}), MissingDatabaseDriverError);
  assert.throws(() => new AdminService({ adminPersistence: null }), MissingDatabaseDriverError);
});

test('Admin Shell: 2. Trusted Actor & Payload Spoofing Rejection', async () => {
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

test('Admin Shell: 3. RBAC Permission Matrix & Separation of Duties', async () => {
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

test('Admin Shell: 4. Rejects Generic DB Mutations and Direct Money Modifications', async () => {
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

test('Admin Shell: 5. Codebase contains no generic recordMutation API calls in AdminService', () => {
  const serviceCode = fs.readFileSync(path.resolve(__dirname, '../domains/admin/service.js'), 'utf8');
  assert.equal(
    serviceCode.includes('recordMutation'),
    false,
    'AdminService must NOT use generic recordMutation({table, action, data}) API'
  );
});

test('Admin Shell: 6. Reason Enforcement for Sensitive Operations', async () => {
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

test('Admin Shell Atomic Rollback: Feature flag remains unchanged after audit failure', async () => {
  const { adminService, adminPersistence } = setupAdminFixture();
  const superAdmin = { actorId: 'super_001', role: QTV_ROLES.SUPER_ADMIN };

  adminPersistence.simulateAuditFailure = true;

  await assert.rejects(async () => {
    await adminService.executeAdminCommand({
      adminActor: superAdmin,
      command: createCommand({
        type: ADMIN_COMMAND_TYPES.FEATURE_FLAG_SET,
        actor: superAdmin,
        payload: { flagKey: 'ACCOUNT_V2', enabled: true, reason: 'Testing atomic rollback' },
      }),
    });
  }, /Simulated audit persistence failure inside transaction/);

  // Assert feature flag remains OFF
  assert.equal(await adminPersistence.isEnabled('ACCOUNT_V2'), false);
  assert.equal((await adminPersistence.getAuditRecords()).length, 0);
});

test('Admin Shell Atomic Rollback: Config draft remains unchanged after audit failure', async () => {
  const { adminService, adminPersistence } = setupAdminFixture();
  const econManager = { actorId: 'econ_001', role: QTV_ROLES.ECONOMY_MANAGER };

  adminPersistence.simulateAuditFailure = true;

  await assert.rejects(async () => {
    await adminService.executeAdminCommand({
      adminActor: econManager,
      command: createCommand({
        type: ADMIN_COMMAND_TYPES.CONFIG_CREATE_DRAFT,
        actor: econManager,
        payload: { version: '2.0.0-draft-test', definitions: {}, reason: 'Drafting' },
      }),
    });
  }, /Simulated audit persistence failure inside transaction/);

  assert.equal(await adminPersistence.getRulesetByVersion('2.0.0-draft-test'), null);
});

test('Admin Shell Atomic Rollback: Config approval remains DRAFT after audit failure', async () => {
  const { adminService, adminPersistence } = setupAdminFixture();
  const econManager = { actorId: 'econ_001', role: QTV_ROLES.ECONOMY_MANAGER };

  // Create valid draft in storage
  await adminPersistence.withTransaction(async (tx) => {
    await tx.config.saveRuleset('2.0.0-atomic', 'DRAFT', {
      'STAKE': { category: CONFIG_CATEGORIES.ECONOMY_CONFIG, value: 100 },
    });
  });

  adminPersistence.simulateAuditFailure = true;

  await assert.rejects(async () => {
    await adminService.executeAdminCommand({
      adminActor: econManager,
      command: createCommand({
        type: ADMIN_COMMAND_TYPES.CONFIG_APPROVE,
        actor: econManager,
        payload: { version: '2.0.0-atomic', reason: 'Approving ruleset' },
      }),
    });
  }, /Simulated audit persistence failure inside transaction/);

  // Assert ruleset remains DRAFT
  const rec = await adminPersistence.getRulesetByVersion('2.0.0-atomic');
  assert.equal(rec.status, 'DRAFT');
});

test('Admin Shell Atomic Rollback: Kill switch remains unchanged after audit failure', async () => {
  const { adminService, adminPersistence } = setupAdminFixture();
  const secReviewer = { actorId: 'sec_001', role: QTV_ROLES.SECURITY_REVIEWER };

  adminPersistence.simulateAuditFailure = true;

  await assert.rejects(async () => {
    await adminService.executeAdminCommand({
      adminActor: secReviewer,
      command: createCommand({
        type: ADMIN_COMMAND_TYPES.KILL_SWITCH_SET,
        actor: secReviewer,
        payload: { switchKey: 'KILL_SWITCH_TEST', active: true, reason: 'Emergency test' },
      }),
    });
  }, /Simulated audit persistence failure inside transaction/);

  assert.equal(await adminPersistence.isKillSwitchActive('KILL_SWITCH_TEST'), false);
});

test('Admin Shell Server-Side Config Approval: Omitted or forged client snapshot cannot approve unresolved persisted config', async () => {
  const { adminService, adminPersistence } = setupAdminFixture();
  const econManager = { actorId: 'econ_001', role: QTV_ROLES.ECONOMY_MANAGER };

  // Save DRAFT ruleset containing TBD_FROM_DATA in database
  await adminPersistence.withTransaction(async (tx) => {
    await tx.config.saveRuleset('2.0.0-tbd', 'DRAFT', {
      'THEFT_CAP': {
        category: CONFIG_CATEGORIES.TBD_FROM_DATA,
        value: CONFIG_CATEGORIES.TBD_FROM_DATA,
      },
    });
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
  const draftRec = await adminPersistence.getRulesetByVersion('2.0.0-tbd');
  assert.equal(draftRec.status, 'DRAFT');
});

test('Admin Shell Server-Driven Prerequisites: Feature prerequisite validation cannot be bypassed by omitting payload config', async () => {
  const { adminService, prerequisiteRegistry, adminPersistence } = setupAdminFixture();
  const superAdmin = { actorId: 'super_001', role: QTV_ROLES.SUPER_ADMIN };

  // Register prerequisite
  prerequisiteRegistry.registerPrerequisites('CARD_WAGER', ['CARD_STAKE_TIERS']);

  // Save approved ruleset with TBD parameter in DB
  await adminPersistence.withTransaction(async (tx) => {
    await tx.config.saveRuleset('1.0.0', 'APPROVED', {
      'CARD_STAKE_TIERS': {
        category: CONFIG_CATEGORIES.TBD_FROM_DATA,
        value: CONFIG_CATEGORIES.TBD_FROM_DATA,
      },
    });
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

test('Admin Shell Audit Integrity: Exactly one audit row is persisted on success with secret stripping', async () => {
  const { adminService, adminPersistence } = setupAdminFixture();
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
  const auditRecords = await adminPersistence.getAuditRecords();
  assert.equal(auditRecords.length, 1);
  assert.equal(auditRecords[0].adminActor.actorId, 'super_001');
  assert.equal(auditRecords[0].metadata.apiKey, '[REDACTED]');
});
