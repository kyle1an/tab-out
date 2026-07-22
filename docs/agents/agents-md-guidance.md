# Research: Writing `AGENTS.md`

_Research date: 2026-07-22. This is a findings note, not a proposed change to the repository's `AGENTS.md`._

## Relevant local tools

- There is no dedicated `AGENTS.md`-authoring skill exposed in this session.
  The closest installed local reference is `writing-great-skills`: it is
  user-invoked and applies useful editorial principles—one source of truth,
  progressive disclosure, and removal of stale or no-op guidance—but it is
  written for `SKILL.md`, not repository instructions.
- The bundled `skill-creator` is for creating a reusable task workflow, not
  for writing `AGENTS.md`.
  Use it only if AGENTS.md audits become a repeated workflow worth a dedicated
  skill.
- For a starter scaffold, Codex CLI provides `/init`; it is a starting point
  to adapt to real repository commands and constraints, not an authoritative
  final document.

## What the official documentation says

- **Codex:** it reads project instructions from the repository root down to the
  current directory; later (more local) files override earlier guidance. The
  combined project-instruction budget is **32 KiB by default**, so use nested
  files only where a subtree has genuinely different rules. The documented
  root-file example covers setup and verification basics. [Custom instructions
  with `AGENTS.md`](https://developers.openai.com/codex/guides/agents-md/)
- **OpenAI's operating recommendation:** treat `AGENTS.md` as a concise map,
  not the repository encyclopedia. Their reported practice is a roughly
  100-line entry point that points to versioned, structured docs as the source
  of truth; this enables progressive disclosure and makes stale knowledge
  easier to find. [Harness
  engineering](https://openai.com/index/harness-engineering/)
- **GitHub Copilot:** it recognizes one or more `AGENTS.md` files in a
  repository, with the nearest file taking precedence. Copilot also has
  repository-wide and path-specific instruction mechanisms, so do not assume
  that its loading model is identical to Codex's layered model. [Repository
  instructions in the IDE](https://docs.github.com/en/copilot/how-tos/configure-custom-instructions-in-your-ide/add-repository-instructions-in-your-ide)
- **GitHub Copilot code review guidance:** write clear, concise, specific,
  imperative rules; use headings and bullets; give a concrete example only
  where wording alone is ambiguous. It recommends starting with 10--20 rules,
  testing them on real pull requests, and adding rules incrementally. Its
  "about 1,000 lines" guidance is for Copilot code-review instructions, not a
  universal `AGENTS.md` limit. [Writing effective custom
  instructions](https://docs.github.com/en/copilot/tutorials/customize-code-review)
- **Claude Code compatibility:** it reads `CLAUDE.md`, not `AGENTS.md`. If a
  repository needs both, its official bridge is a small `CLAUDE.md` that begins
  with `@AGENTS.md`, followed only by Claude-specific additions. [How Claude
  remembers your project](https://code.claude.com/docs/en/memory)

## Synthesis: a practical split

This is an interpretation of the sources above, not a vendor-enforced schema.

| Put in the root `AGENTS.md` | Put elsewhere |
| --- | --- |
| Non-inferable, cross-cutting rules: exact setup/build/test commands, durable safety and Git boundaries, a short architecture map, and links to the authoritative docs. | Long behavior contracts, rationale, examples, procedures, decision records, and reference material. Keep those in versioned docs and point to them. |
| Rules that apply on nearly every task and can be stated as short actions. | Rules that only apply to a subtree: use a nested `AGENTS.md` for Codex, and consider an appropriately scoped Copilot instruction file when Copilot is a target. |
| A small number of high-value completion checks. | Mechanically enforceable formatting or lint policy: prefer CI/lint configuration over prose instructions. |

Good instructions name the triggering condition, required action, and any
safe exception. Avoid generic directions such as "write clean code" or a
large list of details that are already discoverable from code or a linked
source of truth.

## Applied observation for this repository

At the time of this research, the root `AGENTS.md` is 173 lines / 28,750 bytes.
That is below Codex's default 32 KiB **aggregate** project-instruction limit,
but leaves 4,018 bytes before other loaded guidance reaches the cap. Preserve
that budget for durable, always-relevant rules; this repository already has
`CONTEXT.md`, `docs/adr/`, and `docs/agents/` as better homes for deeper,
versioned detail.

## A short authoring checklist

1. Start with verified commands and non-obvious constraints that recur across
   tasks.
2. Group rules by purpose and write short, testable directives.
3. Link to the exact local document that owns detailed behavior; do not copy it
   into every instruction file.
4. Add scoped instructions only when the rules truly differ, then verify the
   target agent's discovery/precedence behavior.
5. Add a rule after a repeated failure or correction, and remove or update it
   when the source of truth changes.
