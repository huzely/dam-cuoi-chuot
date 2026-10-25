# Đám Cưới Chuột V2 — Milestone M1 Final Acceptance Report

**Status**: Milestone M1 Completed & Verified (Pending Live PostgreSQL Integration DB Run)
**Date**: March 2025
**Version**: 2.0.0-m1.4

---

## Executive Summary

Milestone M1 establishes the foundational architecture for Đám Cưới Chuột V2, including domain contracts, persistence primitives, transactional outbox atomicity, scoped idempotency, versioned rulesets with fail-closed configuration, safe feature flags, an administrative RBAC shell with atomic audit logging, and static security verification.

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
| **M1.4 Verification** | Live PostgreSQL Integration Suite | **ENVIRONMENT DEPENDENT** | `postgres-integration.test.js` (Skipped when `POSTGRES_TEST_URL` absent) |

---

## Test Execution Summary

- **Total Test Files**: 10
- **Total Test Cases Executed**: 45
- **Unit & Security Test Suite Pass Rate**: **100% (45 / 45 PASS)**
- **Test Command**: `cd server/v2 && npm test`

### Test Suite Breakdown

1. `command.test.js` (4 tests) — PASS
2. `config.test.js` (3 tests) — PASS
3. `feature-flags.test.js` (3 tests) — PASS
4. `idempotency.test.js` (4 tests) — PASS
5. `outbox.test.js` (4 tests) — PASS
6. `rbac.test.js` (4 tests) — PASS
7. `pg-adapter-contracts.test.js` (7 tests) — PASS
8. `pg-schema-migration.test.js` (1 test) — PASS
9. `admin.test.js` (10 tests) — PASS
10. `security-static.test.js` (5 tests) — PASS
11. `postgres-integration.test.js` (1 test, environment-dependent harness) — SKIPPED (No test DB URL provided)

---

## Live PostgreSQL Integration Status

**Was a real PostgreSQL test/staging database used?**
**NO** — A live PostgreSQL test/staging database instance was NOT provided in the execution environment.

### Status of Verification:
- **Unit & Adapter Contract Verification**: **VERIFIED (100% PASS)** using explicit test drivers (`MemoryAdminPersistence`, `MemoryIdempotencyDriver`, etc.).
- **Static Schema & Security Verification**: **VERIFIED (100% PASS)** via automated file and migration AST/regex scanning (`security-static.test.js` and `pg-schema-migration.test.js`).
- **Live PostgreSQL Engine Execution**: **ENVIRONMENT DEPENDENT / PENDING STAGING RUN**. The integration test harness (`postgres-integration.test.js`) is fully implemented and will execute automatically when `POSTGRES_TEST_URL` is set in the environment.

---

## M2 Handoff Notes

1. Milestone M1 contracts are frozen and ready for Milestone M2 (Account / Auth V2).
2. Production code strictly requires explicit `PgDriver` / `adminPersistence` handles when running in production.
3. Feature flags default safely to OFF and can be safely deployed without impacting legacy players.
