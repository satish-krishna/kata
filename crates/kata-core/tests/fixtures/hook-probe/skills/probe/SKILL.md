---
name: probe
description: Use when the task says to invoke the probe skill. Test fixture only.
hooks:
  Stop:
    - hooks:
        - type: command
          command: 'node "${CLAUDE_PLUGIN_ROOT}/hook.mjs"'
  PreToolUse:
    - matcher: 'Bash|Edit|Write'
      hooks:
        - type: command
          command: 'node "${CLAUDE_PLUGIN_ROOT}/hook.mjs"'
---

# Probe

You are running the probe. Do exactly what the task says, in order, then stop. If a command is refused, report the refusal text and carry on.
