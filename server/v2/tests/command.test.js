import test from 'node:test';
import assert from 'node:assert/strict';
import { createCommand } from '../core/command.js';

test('createCommand creates a valid semantic command with trusted actor', () => {
  const actor = { actorId: 'usr_123', role: 'PLAYER' };
  const cmd = createCommand({
    type: 'festival.enter_booth',
    actor,
    payload: { boothId: 'b_456' },
  });

  assert.equal(cmd.type, 'festival.enter_booth');
  assert.equal(cmd.actor.actorId, 'usr_123');
  assert.equal(cmd.actor.role, 'PLAYER');
  assert.equal(cmd.payload.boothId, 'b_456');
  assert.ok(cmd.commandId.startsWith('cmd_'));
  assert.ok(cmd.timestamp);
});

test('createCommand rejects unauthenticated actor', () => {
  assert.throws(() => {
    createCommand({
      type: 'festival.enter_booth',
      actor: null,
    });
  }, /Authenticated actor with a valid actorId/);

  assert.throws(() => {
    createCommand({
      type: 'festival.enter_booth',
      actor: {},
    });
  }, /Authenticated actor with a valid actorId/);
});

test('createCommand rejects arbitrary client payload actor mismatch', () => {
  const actor = { actorId: 'usr_real' };
  assert.throws(() => {
    createCommand({
      type: 'festival.enter_booth',
      actor,
      payload: { userId: 'usr_imposter' },
    });
  }, /Security Error: Command payload userId\/actorId mismatch/);
});

test('createCommand rejects generic public commands', () => {
  const actor = { actorId: 'usr_123' };
  const forbidden = ['money.add', 'wallet.update', 'inventory.set', 'profile.setRank'];

  for (const type of forbidden) {
    assert.throws(() => {
      createCommand({ type, actor });
    }, /Forbidden generic command type/);
  }
});
