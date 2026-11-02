---
layout: 2
system: demo
---

# Plan: Demo

## Shared decisions

```yaml
- question: log format
  owner: T1
  function: logFormat()
```

## Tasks

### T1: First

```yaml
id: T1
repo: app
depends_on: []
covers: [R1.1]
```

#### Change

One.

#### Tests

One.

### T2: Second

```yaml
id: T2
repo: app
depends_on: [T9]
```

#### Change

Two.

#### Tests

Two.

### T3: Third

```yaml
id: T3
repo: app
depends_on: [T4]
uses: [base branch]
```

#### Change

Three.

#### Tests

Three.

### T4: Fourth

```yaml
id: T4
repo: app
depends_on: []
uses: [log format]
covers: [R9.2]
```

#### Change

Four.

#### Tests

Four.

### T4: Fourth again

```yaml
id: T4
repo: app
depends_on: []
```

#### Change

Four again.

#### Tests

Four again.
