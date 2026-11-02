---
system: demo
---

```gherkin
Feature: Tags without a version
  @R1 @from:D1
  Rule: Written with tags
    @R1.1
    Scenario: Reads
      Given a thing
```
