---
layout: 2
---

# Build log: app

### T1

```yaml
task: T1
commits: ["abc1234"]
notes: |
  The helper is pub(crate) so the next task can reuse it.
```

### T2

```yaml
task: T2
commits: ["def5678"]
departure: |
  R2: hooks with no command are left out of the list; the spec says an item is never left out.
notes: |
  Items sort by declaration order.
```
