---
layout: 2
source_intent: 2026-10-27-steered/intent.md
source_intent_commit: 0123456789abcdef0123456789abcdef01234567
system: kata
date: 2026-10-27
status: accepted
---

# Spec: Rename check

## Requirements

```gherkin
Feature: Rename check
  The helper reports its name.

  @R1 @from:proposed-outcome
  Rule: The helper reports its name

    @R1.1
    Scenario: The helper reports its name
      Given the helper exists
      When it is asked for its name
      Then it answers
```
