---
layout: 2
system: demo
---

# Plan: Demo

## Shared decisions

```yaml
- question: How a diff is shown
  owner: T1
  function: showDiff(d)
```

## Tasks

### T1: Show the diff

```yaml
id: T1
repo: app
depends_on: []
covers: [R1.1]
```

#### Change

Show the diff.

#### Tests

Test it first.

### T2: Show the new diff

```yaml
id: T2
repo: app
depends_on: [T1]
covers: [R1.2]
```

#### Change

Show the new diff.

#### Tests

Test it too.

### T3: Show it everywhere

```yaml
id: T3
repo: app
depends_on: [T1, T2]
uses: [How a diff is shown]
```

#### Change

Use the diff everywhere.

#### Tests

Test it as well.
