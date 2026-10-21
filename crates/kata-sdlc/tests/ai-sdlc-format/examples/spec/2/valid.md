---
layout: 2
system: demo
---

# Spec

```gherkin
Feature: Demo
  @R1 @from:outcome-1 @from:D2
  Rule: The engineer sees what changed
    @R1.1
    Scenario: What changed after a build
      Given a build
      When it ends
      Then the engineer sees the diff

    @R1.2
    Scenario Outline: A payment of <amount>
      Given a bill of <amount>
      Then it is paid

      Examples:
        | amount |
        | 5      |
        | 10     |
```
