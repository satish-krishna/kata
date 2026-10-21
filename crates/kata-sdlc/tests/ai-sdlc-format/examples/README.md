# Conformance examples

Each example is a document and its expected result, side by side:

```
examples/<kind>/<layout>/<name>.md
examples/<kind>/<layout>/<name>.expected.json
```

`<kind>` is `spec`, `plan`, `build-log`, `review` or `change`. A `change` example is a folder, not a file: `examples/change/<layout>/<name>/` holds `spec.md`, `plan.md`, `build/<repo>.md` and an `expected.json` whose `problems` list is what `node check.mjs check` must print for them. `<layout>` is the layout version, `1` or `2`. The `.expected.json` file is the `ReadResult` that `node check.mjs read --json <name>.md` must print, as defined by `schema/read-result.schema.json`. An invalid example carries its problems in the `problems` list of that result.

The format tests read every example and compare. Kata's tests read the same examples at the minimum plugin version, so a change to the format that Kata does not follow fails there.
