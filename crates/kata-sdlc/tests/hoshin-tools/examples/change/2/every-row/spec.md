---
layout: 2
system: demo
---

# Spec

```gherkin
Feature: Demo
  @R1 @from:outcome-1
  Rule: The engineer sees what changed
    @R1.1
    Scenario: What changed after a build
      Given a build
      Then the engineer sees the diff

    @R1.2
    Scenario: What changed after a rebuild
      Given a rebuild
      Then the engineer sees the new diff
```
