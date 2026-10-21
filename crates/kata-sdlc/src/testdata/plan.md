---
source_spec: 2026-10-12-fnol/spec.md
source_spec_commit: 0123456789abcdef0123456789abcdef01234567
system: claims
date: 2026-10-12
author: Test
status: accepted
---

# Plan: First notice of loss

## Approach

Add the intake form in `app`, the endpoint in `api`, and document it in the master repository.

## Tasks

### T1: Intake form (`app`)

- **Depends on:** none
- **Files:** `src/intake.ts`
- **Change:** Add the form.
- **Tests:** `intake_validates`.
- **Done when:** the test passes.

### T2: Intake endpoint (`api`)

- **Depends on:** none
- **Files:** `src/intake.rs`
- **Change:** Add the endpoint.
- **Tests:** `intake_accepts`.
- **Done when:** the test passes.

### T3: Submit the form to the endpoint (`app`)

- **Depends on:** T1, T2
- **Files:** `src/submit.ts`
- **Change:** Post the form.
- **Tests:** `submit_posts`.
- **Done when:** the test passes.

### T4: Document the intake flow (`docs`)

- **Depends on:** T3
- **Files:** `docs/intake.md`
- **Change:** Describe it.
- **Tests:** none.
- **Done when:** the page exists.

### T5: Audit log (`api`)

- **Files:** `src/audit.rs`
- **Change:** Log every intake.
- **Tests:** `audit_logs`.
- **Done when:** the test passes.

## Order and dependencies

T1 and T2 build in parallel.

## Build log

| Task | Repository | Commits | Departure |
|---|---|---|---|
| T1 | app | `aaa1111` | none |
| T2 | api | `bbb2222`, `ccc3333` | Skipped the retry because the gateway retries. |
