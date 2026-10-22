---
layout: 2
system: demo
---

# Spec

```gherkin
Feature: Demo
  @R2 @from:D1
  Rule: Two
    @R2.2
    Scenario Outline: Pays
      Given <amount> and <who>
      Examples:
        | who |
        | me  |
```
