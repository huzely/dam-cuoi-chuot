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

    // Verify all Pg* adapter classes in adapters/ require dbClient and throw MissingDatabaseDriverError
    if (content.includes('export class Pg') && !relativePath.includes('pg-driver.js')) {
      assert.ok(
        content.includes('MissingDatabaseDriverError'),
        `Architecture Violation: Adapter ${relativePath} must require explicit DB driver and throw MissingDatabaseDriverError`
      );
    }
  }
});

test('Security Static Scan 5: AdminService does not use generic recordMutation API', () => {
  const servicePath = path.join(v2RootDir, 'domains/admin/service.js');
  const content = fs.readFileSync(servicePath, 'utf8');

  assert.equal(
    content.includes('recordMutation'),
    false,
    'Architecture Violation: AdminService must not use generic recordMutation({table, action, data}) API'
  );
});
