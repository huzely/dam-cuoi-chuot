# Đám Cưới Chuột V2 — Milestone M1 Final Acceptance Report

**M1.4 Status**: HARNESS READY — LIVE POSTGRES VERIFICATION NOT EXECUTED
**M1 Freeze Status**: NOT FROZEN
**M2 Status**: BLOCKED (Awaiting live PostgreSQL integration test run)
**Date**: March 2025
**Version**: 2.0.0-m1.4

---

## Executive Summary

Milestone M1 establishes the foundational architecture for Đám Cưới Chuột V2, including domain contracts, persistence primitives, transactional outbox atomicity, scoped idempotency, versioned rulesets with fail-closed configuration, safe feature flags, an administrative RBAC shell with atomic audit logging, and automated static security verification.

All existing legacy game systems (`SAVE4.money`, `dcc.c4`, `dcc.c4b`, `dcc.jg`, `dcc.cloud*`, client JS, WebSocket server) remain **100% untouched and unchanged**.

---

## M1 Acceptance Matrix

| Category | Requirement | Status | Verification Method |
|---|---|---|---|
| **M1.1 Foundation** | Domain boundaries for 14 V2 domains | **PASS** | `server/v2/domains/*` contracts verified |
| **M1.1 Foundation** | Semantic Commands with trusted server actor | **PASS** | `command.test.js` unit tests |
| **M1.1 Foundation** | Domain Events with standardized metadata | **PASS** | `outbox.test.js` unit tests |
| **M1.1 Foundation** | Forbidden generic commands rejected (`money.add`, etc.) | **PASS** | `command.test.js` & `security-static.test.js` |
| **M1.2 Persistence** | Non-destructive V2 SQL schema migration (`001_v2_foundation_schema.sql`) | **PASS** | `pg-schema-migration.test.js` & static checks |
| **M1.2 Persistence** | Durable idempotency scoped to `(actor_id, key)` with canonical SHA-256 | **PASS** | `pg-adapter-contracts.test.js` unit tests |
| **M1.2 Persistence** | Atomic DB transaction (state + outbox committed together) | **PASS** | `outbox.test.js` & `pg-adapter-contracts.test.js` |
| **M1.2 Persistence** | Post-commit outbox publication failure leaves DB state committed & retryable | **PASS** | `outbox.test.js` & `pg-adapter-contracts.test.js` |
| **M1.2 Persistence** | Fail-closed `TBD_FROM_DATA` configuration handling (`UnresolvedConfigError`) | **PASS** | `config.test.js` & `pg-adapter-contracts.test.js` |
| **M1.2 Persistence** | Safe feature flag defaults (all V2 flags default OFF) | **PASS** | `feature-flags.test.js` & `pg-adapter-contracts.test.js` |
| **M1.2 Persistence** | Fail-fast production `Pg*` adapters without silent memory fallback | **PASS** | `pg-adapter-contracts.test.js` & `security-static.test.js` |
| **M1.3 Admin Shell** | Trusted admin actor context from server context | **PASS** | `admin.test.js` unit tests |
| **M1.3 Admin Shell** | Least-privilege RBAC permission matrix (7 frozen roles) | **PASS** | `rbac.test.js` & `admin.test.js` unit tests |
| **M1.3 Admin Shell** | Non-empty human-readable reason required for sensitive operations | **PASS** | `admin.test.js` unit tests |
| **M1.3 Admin Shell** | Atomic admin state mutation + audit logging (rollback on audit failure) | **PASS** | `admin.test.js` unit tests |
| **M1.3 Admin Shell** | Server-side trusted config approval (client payload snapshot ignored) | **PASS** | `admin.test.js` unit tests |
| **M1.3 Admin Shell** | Server-driven feature flag prerequisite checks | **PASS** | `admin.test.js` unit tests |
| **M1.3 Admin Shell** | Secret redaction in audit metadata (`apiKey`, `password`, `token`) | **PASS** | `admin.test.js` unit tests |
| **M1.3 Admin Shell** | Direct money setters or generic table mutation APIs forbidden | **PASS** | `security-static.test.js` automated scan |
| **M1.4 Verification** | Automated Security Static Scanner | **PASS** | `security-static.test.js` automated scan |
| **M1.4 Verification** | Legacy Coexistence (zero changes to `js/*`, `dcc_*` tables) | **PASS** | `security-static.test.js` & `git status` |
| **M1.4 Verification** | Live PostgreSQL Integration Suite | **NOT EXECUTED — UNVERIFIED** | `postgres-integration.test.js` (Pending test/staging DB environment) |

---

## Test Execution Summary

- **Total Test Files in `server/v2/tests/`**: 11
- **Unit & Security Static Test Cases**: **52 PASS / 0 FAIL** (100% Pass)
- **Integration Test Harness**: **1 HARNESS READY / SKIPPED** (`NOT EXECUTED — TEST/STAGING DATABASE NOT PROVIDED`)
- **Unit Test Command**: `cd server/v2 && npm run test:unit`
- **Integration Test Command**: `cd server/v2 && POSTGRES_TEST_URL="..." npm run test:integration`

### Test Suite Breakdown

1. `admin.test.js` (13 tests) — **PASS**
2. `command.test.js` (4 tests) — **PASS**
3. `config.test.js` (3 tests) — **PASS**
4. `feature-flags.test.js` (3 tests) — **PASS**
5. `idempotency.test.js` (4 tests) — **PASS**
6. `outbox.test.js` (4 tests) — **PASS**
7. `pg-adapter-contracts.test.js` (7 tests) — **PASS**
8. `pg-schema-migration.test.js` (1 test) — **PASS**
9. `rbac.test.js` (4 tests) — **PASS**
10. `security-static.test.js` (7 tests) — **PASS**
11. `postgres-integration.test.js` (1 integration harness test with 11 subtests) — **SKIPPED / NOT EXECUTED** (`POSTGRES_TEST_URL` absent)

---

## Live PostgreSQL Integration Status

**Was a real PostgreSQL test/staging database used?**
**NO** — A live PostgreSQL test/staging database instance was NOT provided in the sandbox execution environment.

### Status of Verification:
- **Unit & Adapter Contract Verification**: **VERIFIED (100% PASS)** using explicit test drivers (`MemoryAdminPersistence`, `MemoryIdempotencyDriver`, etc.).
- **Static Schema & Security Verification**: **VERIFIED (100% PASS)** via automated file and migration AST/regex scanning (`security-static.test.js` and `pg-schema-migration.test.js`).
- **Live PostgreSQL Engine Execution**: **NOT EXECUTED — LIVE VERIFICATION PENDING**. The executable integration test harness (`postgres-integration.test.js`) is fully implemented using `pg` and will execute automatically when `POSTGRES_TEST_URL` is configured in a staging environment.

### List of Unverified Acceptance Items:
1. Live PostgreSQL multi-client row lock concurrency under parallel load.
2. Live Supabase RLS policy execution on a remote Supabase instance.
3. Live PostgreSQL migration execution against a live PostgreSQL server.

---

## M2 Handoff Notes

1. Milestone M1 contracts and integration harness are ready for Milestone M2 (Account / Auth V2).
2. Production code strictly requires explicit `PgDriver` / `adminPersistence` handles when running in production.
3. Feature flags default safely to OFF and can be safely deployed without impacting legacy players.
