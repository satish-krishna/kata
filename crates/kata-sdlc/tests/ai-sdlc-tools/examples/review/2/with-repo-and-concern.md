---
layout: 2
---

# Review findings

## Review 1

```yaml
review: 1
reviewed_at: 2026-10-23
commits: { app: 840fa0c, api: 1234567 }
```

### F1

```yaml
id: F1
severity: high
repo: api
concern: spec
file: src/limits.ts
line: 42
```

The limit is not enforced on retry, so R2.1's second request goes through.

### F2

```yaml
id: F2
severity: low
repo: app
concern: convention
rule: CONTRIBUTING.md:18
file: src/greet.ts
line: 7
```

Exported functions need a doc comment; `greet` has none.

### F3

```yaml
id: F3
severity: medium
file: README.md
line: 3
```

A finding from before repositories and concerns were recorded still reads.
