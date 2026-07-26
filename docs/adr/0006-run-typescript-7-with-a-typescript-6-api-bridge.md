# ADR 0006: Run TypeScript 7 With A TypeScript 6 API Bridge

- Status: Accepted
- Date: 2026-07-26

## Context

TypeScript 7 is the native compiler and does not expose the JavaScript compiler
API used by parts of Tab Out's tooling. The application and test projects pass
under TypeScript 7, but `typescript-eslint` still requires TypeScript earlier
than 6.1 and fails when forced to load TypeScript 7 as its API provider.

Microsoft supports this transition with a side-by-side layout: TypeScript 7
owns the `tsc` executable, while `@typescript/typescript6` remains available as
the `typescript` package for tools that import the legacy compiler API. An
isolated Tab Out trial of that layout passed the full verification pipeline.

## Decision

Make TypeScript 7 the authoritative command-line compiler now. Retain
TypeScript 6 only as a compatibility API for existing tooling, and do not
combine the compiler migration with an ESLint-to-Oxlint migration.

Declare `@typescript/native` as the npm alias
`npm:typescript@^7.0.2`, and declare `typescript` as the npm alias
`npm:@typescript/typescript6@^6.0.2`. These ranges follow the repository's
normal dependency policy; the pnpm lockfile remains the reproducible install
authority.

Run both application and test project checks with TypeScript 7 through the
normal `typecheck` and `verify` scripts. Run TypeScript 6 against both projects
once while validating the migration, but do not keep it as a second CI gate;
afterward it exists only for compiler-API consumers and targeted diagnosis.

Keep editor adoption developer-controlled. The repository does not require or
recommend a TypeScript 7 editor extension, nor select a workspace language
server as part of this compiler migration.

Keep repository source parseable by TypeScript 6 while any required tool still
uses its compiler API. TypeScript 7 owns type diagnostics, but TypeScript-7-only
syntax is out of scope until those legacy API consumers are removed or moved to
the new API.

Treat the dual-version layout as a migration bridge rather than the desired
end state. Remove it once every required compiler-API consumer supports the
TypeScript 7 API or has been deliberately replaced.

When the bridge is implemented, document the command/package split briefly in
`AGENTS.md` and link back to this ADR so routine dependency cleanup does not
collapse it accidentally. Do not add contributor-tooling detail to the public
product setup in `README.md`.

Accept the migration only when TypeScript 7 passes both repository projects,
TypeScript 6 passes both once for migration parity, ESLint succeeds through the
legacy API bridge, and the full `pnpm verify` pipeline passes without changing
generated extension bundles. Browser QA is not part of this toolchain-only
change because no runtime source or emitted runtime behavior changes.

## Consequences

Tab Out gets TypeScript 7's compiler and language-service path without forcing
an unrelated lint-policy migration. The dependency names must make compiler
ownership explicit, and maintenance temporarily includes both TypeScript
generations. CI has one authoritative type result instead of permanently
running two compilers whose results may diverge during the transition. Editor
rollout can follow the editor vendors' TypeScript 7 integration independently.
New TypeScript syntax remains limited by the oldest parser in the verified
toolchain for the lifetime of the bridge.

## References

- [Announcing TypeScript 7.0](https://devblogs.microsoft.com/typescript/announcing-typescript-7-0/)
- [typescript-eslint dependency versions](https://typescript-eslint.io/users/dependency-versions/)
