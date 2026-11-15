---
layout: 2
system: demo
---

# Spec

```gherkin
Feature: Demo
  @R1 @from:D1
  Rule: One
    @R1.1
    Scenario: First
      Given a thing
```

More requirements, added in a block of their own, are never read.

```gherkin
Feature: Demo
  @R2 @from:D1
  Rule: Two
    @R2.1
    Scenario: Second
      Given a thing
```
