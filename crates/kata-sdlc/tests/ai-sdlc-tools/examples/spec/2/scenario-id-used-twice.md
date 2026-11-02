---
layout: 2
system: demo
---

# Spec

```gherkin
Feature: Demo
  @R2 @from:D1
  Rule: Two
    @R2.1
    Scenario: First
      Given x

    @R2.1
    Scenario: Second
      Given y
```
