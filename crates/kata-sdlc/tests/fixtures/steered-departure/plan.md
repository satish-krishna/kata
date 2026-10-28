---
layout: 2
source_spec: 2026-10-27-steered/spec.md
source_spec_commit: 0123456789abcdef0123456789abcdef01234567
system: kata
date: 2026-10-27
author: Test
status: accepted
---

# Plan: Rename check

## Approach

One task in one repository.

## Tasks

### T1: Report the helper name

```yaml
id: T1
repo: kata
depends_on: []
uses: []
files: [src/helper.rs]
covers: [R1.1]
```

#### Change

Make the helper report its name.

#### Tests

`helper_reports_its_name`.

#### Done when

The test passes.
