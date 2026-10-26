---
name: devharness-contributing
description: Conventions for writing code in the devharness repo itself (as opposed to using its tools to debug some other app) - how tool failures propagate, why behaviour must read _meta rather than rendered text, where each kind of documentation lives, and the release rules an agent gets wrong. Use when editing files under src/, adding or changing an MCP tool, cutting a release, or debugging why a rebuild didn't take effect in a live session.
---

# Contributing to devharness

**Read `CONTRIBUTING.md` first.** It owns the mechanics — build and test commands, running your build as `devharness-dev`, hot-reload and how to tell whether it took, `stress:suspend`, the release sequence, and the doc-sync list. It is the single source for all of that; this skill does not repeat it.

What follows is what `CONTRIBUTING.md` does not say: the code conventions, and the release habits an agent specifically gets wrong.

## Releasing: what an agent gets wrong

The sequence is in `CONTRIBUTING.md`. Three things about it change how you should behave, not just what you type:

- **`npm run build:verify` before bumping, always.** Skipping it once put out a tag whose publish failed on a stale `plugin/.mcp.json` pin, while `notify-marketplace` had already opened a PR pinning a version npm never received. After the tag, it is too late.
- **`postversion` pushes the branch and the tag with no confirmation.** Every local commit on `main` ships. Nothing is "committed but held back locally" once someone bumps — never describe a commit that way, and make `main` exactly what should ship before bumping.
- **Don't offer to push afterwards, and don't say a release "wasn't published".** Both already happened. Check rather than guess: `gh run list --workflow=publish.yml`, `npm view devharness version`.

Never run `npm publish` by hand — a second unverified path to the registry that collides with the run the tag already started.

## Tool failures are THROWN, not returned

`executeToolCall` (`src/index.ts`) converts any `isError` response into a thrown `ToolError` (`src/tool-error.ts`) carrying that response. **Downstream code branching on `result.isError` is dead**, and a fake `executeToolCall` that *returns* isError responses covers that dead branch while the live path goes untested. That mismatch shipped absent-element conditions failing whole runs, `LAUNCH_FAILED` never reaching the user, and a leaked verification tab.

- **Wrap every fake `executeToolCall` in `productionShaped()`** (`src/test-support/fake-execute-tool-call.ts`). Import the real `ToolError` rather than re-declaring its shape.
- **Classify failures by `_errorId`, not message text.** `createErrorResponse` attaches it and `ToolError` carries the response, so `err.response._errorId` is available in-process. `isElementNotFoundFailure()` in `messages.ts` is the worked example.
- **Build fixtures with the real helpers** (`createErrorResponse`, `getErrorMessage`, `formatCodeBlock`, `webStorageMeta`). Hand-written text drifts: fixtures asserted `Element not found: ...` for a year while `MessageManager` emitted `Error: Element not found: ...`.

## Read `_meta`, never rendered text

Structured results live in `_meta` (`src/tool-response.ts`). Anything deciding *behaviour* must read that — rendered text mixes our formatting with page-controlled data. Every instance of grepping the markdown was a bug: a localStorage `"null"` read as absent, a URL containing a comma compared truncated, `**error**` counted inside a logged message, `\d{3}` matching any three digits as an HTTP status.

If the data isn't in `_meta`, add it there rather than parsing the string. **No text fallback "just in case"** — production has one shape, and a fallback no path reaches is untestable and hides drift. The one exception is a raw library exception with no `_errorId`.

## Which file takes the prose

- `src/tools/*.ts` — one file per tool family, action-based schemas.
- `docs/mcp-instructions.md` — sent on every MCP connection, injected unconditionally. Keep it tiny.
- `docs/instructions.md` — full tool reference for clients without Agent Skills support.
- `docs/bench.md`, `docs/boundary.md`, `docs/sequences.md` — reference for people on the bench, the traffic boundary and sequences. Operational facts an agent needs go where the instructing-sessions skill places them, not here.
- `docs/messages.md` — source of truth for response text (`## MESSAGE_ID` sections), parsed at runtime by `messages.ts`. Costs tokens only when that call happens, so detail is fine here.

**Keep tool schema descriptions terse** (`.describe()` and `createTool()`'s first argument). They go to every session at `listTools` time whether or not the tool is ever called — a fixed cost, not a progressive-disclosure surface. Put why/when/what-happens in the shipped skill or its `references/`.

**Skill and reference prose is a token budget, not a page count.** Say it once, in the fewest words that survive being wrong. Cut restatement and any sentence that only reassures. If a paragraph and a table say the same thing, keep the table.

**Comments are not journals.** What the code does, or why the non-obvious choice was made, in one line where possible. No narrating history ("this used to..."), no arguing with a previous author, no restating the line below. Git holds history; the comment holds the constraint.

## Config philosophy

Per `docs/working_with_llm_notes.md`: LLMs editing this server's own behavior are optimistic and sometimes wrong. Any LLM-driven config change needs a manual override path the user can reach without going through the LLM — don't add a setting only reachable through an agent's tool calls.
