---
source_spec: <change>/spec.md
source_spec_commit: <full SHA of the spec.md commit this plan was written from>
system: <system>
date: <YYYY-MM-DD>
author: <engineer>
status: draft
---

# Plan: <title>

## Approach

<Two to four sentences: the shape of the change and why this shape.>

## Scenario coverage

Every scenario in the spec's Gherkin block appears here with at least one test.

| Scenario | Test | Task |
|---|---|---|
| R1.1 | <test name> | T2 |

## Tasks

### T1: <name> (`<repo>`)

- **Depends on:** <task IDs this task needs built first, or none>
- **Files:** <paths to create or change>
- **Change:** <what changes and why>
- **Tests:** <the failing test written first: its name, the scenario IDs it covers and supports, the command that runs it, and why it fails before the change>
- **Done when:** <the observable check>

## Order and dependencies

<Why the dependencies are what they are, the cross-repository ordering if any, and which repositories can be built at the same time.>

## Risks

- **Riskiest step:** <task and why>
- **What could break:** <existing behavior at risk, and how the plan protects it>

## Rejected alternatives

- <Alternative>: <why not>
