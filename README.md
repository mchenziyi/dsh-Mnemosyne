# dsh-Mnemosyne

> Long-term memory and progressive disclosure for DeepSeek Harness.

`dsh-Mnemosyne` is a native DeepSeek Harness plugin for organizing durable agent
memory as an OKF-style knowledge graph and revealing only the context needed for
the current task.

This project is independent of `oh-my-reasonix` (OMR). It does not depend on OMR
code, configuration, CLI commands, or release versions.

## Goals

- store durable engineering experience as structured, reviewable memory;
- organize relationships through OKF Wiki pages and deterministic indexes;
- use progressive disclosure to avoid injecting the entire memory corpus into a turn;
- preserve provenance, lifecycle, health, and freeze semantics;
- integrate through DeepSeek Harness's plugin and session/event extension points.

## Scope

The first milestone focuses on memory only:

```text
Harness session/events
  -> memory extraction
  -> OKF storage and indexing
  -> librarian retrieval
  -> progressive disclosure
  -> model-context injection
```

Plugin self-evolution is a later milestone. It will be designed as a governed
loop for proposing, sandboxing, canarying, observing, promoting, freezing, and
rolling back plugins. The plugin must never directly modify the Harness security
core or silently rewrite canonical memory facts.

## Status

Early design and implementation stage. Protocols and plugin integration points
will be documented before production behavior is enabled.

## License

License selection is pending.
