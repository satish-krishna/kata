---
system: demo
status: accepted
---

# Spec: An older document

```gherkin
Feature: Old layout
  Rule: R1 - Hyphen separator (from: D1)
    Scenario: R1.1 – En dash separator
      Given a thing
      Then it is read

  Rule: R2 — Em dash separator (from: Proposed outcome 1–2, D3)
    Scenario Outline: R2.1 — Pays <amount>
      Given a bill of <amount>
      Then it is paid

      Examples:
        | amount |
        | 5      |
```
