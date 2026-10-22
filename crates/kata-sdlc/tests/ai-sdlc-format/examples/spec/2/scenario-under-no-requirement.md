---
layout: 2
system: demo
---

# Spec

```gherkin
Feature: Demo
  @R1.1
  Scenario: Stray
    Given a thing

  @R2 @from:D1
  Rule: Two
    @R2.1
    Scenario: Second
      Given a thing
```
