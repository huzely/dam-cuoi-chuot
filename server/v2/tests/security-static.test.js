import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const v2RootDir = path.resolve(__dirname, '..');

function getAllFiles(dirPath, arrayOfFiles = []) {
  const files = fs.readdirSync(dirPath);
  for (const file of files) {
    const fullPath = path.join(dirPath, file);
    if (fs.statSync(fullPath).isDirectory()) {
      getAllFiles(fullPath, arrayOfFiles);
    } else {
      arrayOfFiles.push(fullPath);
    }
  }
  return arrayOfFiles;
}

test('Security Static Scan 1: No hardcoded service_role keys or secrets in V2 code', () => {
  const files = getAllFiles(v2RootDir).filter(f => f.endsWith('.js') || f.endsWith('.sql'));

  for (const filePath of files) {
    const content = fs.readFileSync(filePath, 'utf8');
    const relativePath = path.relative(v2RootDir, filePath);

    assert.equal(
      content.includes('service_role') && !relativePath.includes('security-static.test.js'),
      false,
      `Security Violation: Hardcoded service_role reference found in ${relativePath}`
    );
    assert.equal(
      content.includes('eyJhbGciOiJIUzI1NiI') && !relativePath.includes('security-static.test.js'),
      false,
      `Security Violation: Hardcoded JWT secret token found in ${relativePath}`
    );
  }
});

test('Security Static Scan 2: No schema-wide privilege revokes in V2 migration scripts', () => {
  const sqlFiles = getAllFiles(v2RootDir).filter(f => f.endsWith('.sql'));

  for (const filePath of sqlFiles) {
    const content = fs.readFileSync(filePath, 'utf8');
    const relativePath = path.relative(v2RootDir, filePath);

    assert.equal(
      content.includes('ON ALL TABLES IN SCHEMA'),
      false,
      `Schema Violation: Schema-wide privilege revoke found in ${relativePath}`
    );
  }
});

test('Security Static Scan 3: No executable direct money setters or wallet overrides in Admin domain', () => {
  const adminFiles = getAllFiles(path.join(v2RootDir, 'domains/admin')).filter(f => f.endsWith('.js'));

  const forbiddenMethods = ['setBalance(', 'addMoney(', 'moneySet(', 'walletOverride('];

  for (const filePath of adminFiles) {
    const content = fs.readFileSync(filePath, 'utf8');
    const relativePath = path.relative(v2RootDir, filePath);

    for (const method of forbiddenMethods) {
      assert.equal(
        content.includes(method),
        false,
        `Security Violation: Executable direct money/wallet setter "${method}" found in ${relativePath}`
      );
    }
  }
});

test('Security Static Scan 4: Production Pg adapters fail fast without silent memory fallback', () => {
  const adapterFiles = getAllFiles(path.join(v2RootDir, 'adapters')).filter(f => f.endsWith('.js'));

  for (const filePath of adapterFiles) {
    const content = fs.readFileSync(filePath, 'utf8');
    const relativePath = path.relative(v2RootDir, filePath);

    if (content.includes('export class Pg') && !relativePath.includes('pg-driver.js')) {
      assert.ok(
        content.includes('MissingDatabaseDriverError'),
        `Architecture Violation: Adapter ${relativePath} must require explicit DB driver and throw MissingDatabaseDriverError`
      );
    }
  }
});

test('Security Static Scan 5: Production V2 modules do not expose or invoke generic recordMutation API', () => {
  const productionTargetDirs = [
    path.join(v2RootDir, 'adapters'),
    path.join(v2RootDir, 'domains'),
    path.join(v2RootDir, 'core'),
  ];

  let prodFiles = [];
  for (const dir of productionTargetDirs) {
    if (fs.existsSync(dir)) {
      prodFiles = prodFiles.concat(getAllFiles(dir).filter(f => f.endsWith('.js')));
    }
  }

  for (const filePath of prodFiles) {
    const content = fs.readFileSync(filePath, 'utf8');
    const relativePath = path.relative(v2RootDir, filePath);

    assert.equal(
      content.includes('recordMutation(') || content.includes('recordMutation:'),
      false,
      `Architecture Violation: Generic table mutation API "recordMutation" found in production file ${relativePath}`
    );
  }
});

test('Security Static Scan 6: Integration test harness contains real database queries and no placeholder assertions', () => {
  const integrationPath = path.join(v2RootDir, 'tests/postgres-integration.test.js');
  const content = fs.readFileSync(integrationPath, 'utf8');

  assert.ok(
    content.includes('pool.query') || content.includes('pgDriver.withTransaction'),
    'Integration test must execute real PostgreSQL queries'
  );
  assert.equal(
    content.includes('assert.ok(true);'),
    false,
    'Architecture Violation: Integration test steps must execute real assertions rather than assert.ok(true) placeholders'
  );
});

test('Security Static Scan 7: No post-COMMIT mutation hooks in PgTransactionAdapter or PgDriver', () => {
  const txPath = path.join(v2RootDir, 'adapters/pg-transaction.js');
  const driverPath = path.join(v2RootDir, 'adapters/pg-driver.js');

  const txContent = fs.readFileSync(txPath, 'utf8');
  const driverContent = fs.readFileSync(driverPath, 'utf8');

  assert.equal(
    txContent.includes('onCommit(') || driverContent.includes('onCommit('),
    false,
    'Architecture Violation: Authoritative mutations must not use onCommit hooks'
  );
});

test('Security Static Scan 8: No OAuth credentials or secrets stored in V2 identity mapping tables', () => {
  const identityFiles = getAllFiles(path.join(v2RootDir, 'domains/identity')).filter(f => f.endsWith('.js'));
  const forbiddenTokens = ['access_token', 'refresh_token', 'oauth_token', 'password_hash', 'client_secret'];

  for (const filePath of identityFiles) {
    const content = fs.readFileSync(filePath, 'utf8');
    const relativePath = path.relative(v2RootDir, filePath);

    for (const token of forbiddenTokens) {
      assert.equal(
        content.toLowerCase().includes(token),
        false,
        `Security Violation: Forbidden credential token reference "${token}" found in ${relativePath}`
      );
    }
  }
});
