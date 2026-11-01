---
system: demo
---

# Plan: Old shape

## Shared decisions

| Question | Owner | Defined as | Used by |
|---|---|---|---|
| How a problem is reported | T1 | `formatProblem(p)` | T2 |

## Tasks

### T1: First task (`app`)

- **Depends on:** none
- **Files:** src/a.ts
- **Tests:** a failing test first

### T2: Second task (`app`)

- **Change:** no Depends on line, so it depends on every task above
