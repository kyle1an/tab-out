# Engineering Change Ledger

Completed proposal bodies are removed once their durable decisions live in code,
tests, `CONTEXT.md`, or an ADR. This ledger keeps the useful historical outcome
without retaining stale execution instructions.

| Wave | Outcome | Commits |
| --- | --- | --- |
| Animation audit (001–004) | Unified motion tokens and exit timing, narrowed transition properties, and aligned the source-switch indicator curve. | `ac28415`, `038fd4f`, `61562e3`, `9fa5606` |
| Architecture audit (005–008) | Added the Browser Tabs Gateway, shared FLIP move module, and suppression-tone view-model data. The proposed shared title-expansion measurer was rejected; [ADR-0002](../docs/adr/0002-title-expansion-measurement-stays-per-surface.md) records why the per-surface engines remain separate. | `3db7cb6`, `e62cbeb`, `73f71a0`, `cd460ef`, `31fc77c` |
| React audit (009–012) | Stabilized App seams, restored compiler coverage for chip and history hot paths, and surfaced source-switch failures. | `8350a33`, `b0ba829`, `60b8ee8`, `7361a3c` |

The React Compiler baseline is enforced by
[`scripts/react-compiler-check.mjs`](../scripts/react-compiler-check.mjs).
Runtime behavior contracts remain in [`AGENTS.md`](../AGENTS.md) and
[`CONTEXT.md`](../CONTEXT.md).
