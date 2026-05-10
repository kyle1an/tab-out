# Domain Docs

This repo uses a single-context domain documentation layout.

## Before exploring, read these

- `CONTEXT.md` at the repo root for project vocabulary.
- `docs/adr/` for architectural decisions that touch the area you're about to work in.

If any of these files don't exist, proceed silently. Don't flag their absence or suggest creating them upfront.

## Use the glossary's vocabulary

When your output names a domain concept, use the term as defined in `CONTEXT.md`.

If the concept you need isn't in the glossary yet, either reconsider whether the repo uses that term or note the gap for future domain documentation.

## Flag ADR conflicts

If your output contradicts an existing ADR, surface it explicitly rather than silently overriding it.
