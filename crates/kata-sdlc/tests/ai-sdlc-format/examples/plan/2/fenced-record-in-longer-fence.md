---
layout: 2
system: demo
---

# Plan: New shape

## Shared decisions

```yaml
- question: How a problem is reported
  owner: T1
  function: formatProblem(p)
```

## Tasks

### T1: First task

```yaml
id: T1
repo: app
depends_on: []
files: [src/a.ts]
covers: [R1.1]
```

#### Change

Write it.

Quote a record the way a document about this format does:

````md
### T9: Example

```yaml
id: T9
repo: app
```
````

#### Tests

Test it first.

#### Done when

It passes.

### T2: Second task

```yaml
id: T2
repo: app
depends_on: [T1]
uses: [How a problem is reported]
supports: [R1.1]
```

#### Change

Use it.

#### Tests

Test it too.

#### Done when

It passes.
