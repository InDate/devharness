---
name: instructing-sessions
description: Where each fact devharness sends a session belongs, and how a session is moved off a worse path. Use when adding or changing any text a session receives from devharness - server instructions, the SessionStart hook, a tool or parameter description, reply or error text in docs/messages.md, a once-per-session block, a footer - when moving or deleting a skill or reference, and when designing a capability meant to replace something agents do another way.
---

# Instructing sessions

What a session holds of devharness is the text devharness puts in front of it.
Every character of that text is paid for twice: once when it arrives, and
again on every later request of the session, since each request re-reads the
whole context. A fact therefore earns its place by arriving at the **moment**
the call it bears on is made, and by arriving there once.

## The moments

A fact has one **home**: the channel that reaches the moment it is needed.

| Moment | What the agent needs then | Home |
|---|---|---|
| **Start** - the session begins | That devharness exists and which jobs to reach for it with | `docs/mcp-instructions.md`, `plugin/hooks/session-start.mjs` |
| **Choice** - a tool is being picked | What the tool is for | The tool description; the `action` enum carries the action names alone |
| **First use** - an action's first call in the session | How to use it well | A once-per-session block in that message's section of `docs/messages.md` |
| **Error** - a call failed or was refused | What was missing, and the call that recovers | The error text, with the recovering call written out |
| **Worse path** - the session does a job another way | That a devharness path exists and what it costs | A once-per-session block on the reply that sees the worse path |

Start text is paid by every session, used or not: it carries discovery and
nothing else. A parameter's description carries what that parameter does,
since the schema arrives at **choice**. A fact about one action of a tool
arrives with that action: at its **first use**, or in its **error**. A fact
needed at no moment has no home and is deleted.

Reference for people (design notes, catalogues, history) lives in `docs/` and
the README, where no session pays for it.

## Skills hold reference for people

A skill reaches a session only when the session loads it, and loads land late,
rarely, or on a copy left behind by an earlier version. Text that a session
needs to operate has to sit on a channel that reaches every session at its
moment. A skill or reference holds what a person reads; an operational fact
found there moves to its home in the table.

## The session ledger

Each channel that adds text to a session keeps a per-session record of what
it has already delivered, the way `once` blocks do (`src/messages.ts`). Text
the session already holds is replaced by a reference to where it stands, or
by what changed since: a listing prints in full once and as its changes after;
a footer prints when its value moves. The ledger is keyed by session, so a
cleared or new session receives the full text again.

## Round trips

A request costs the context re-read many times over what the request's own
text costs. Of two paths to one job, the one with fewer requests is the one
taken, whatever any instruction states. So a better path is
offered at **worse path** only once it takes no more requests than the path
it replaces. Where it takes more, the work is a capability first - for
driving a page, one call that chains real steps and reads the page back -
and the instruction after.

## Placing a fact

1. Name the fact as one sentence, and what a session does without it. The
   fact enters a session channel when its absence produces an error, a stall,
   a worse path, or a first use that goes wrong; a fact whose absence produces
   none of these goes to `docs/` for people, and the remaining steps stop here.
2. Name the moment a session needs it.
3. Put it in the home for that moment, written for that moment: a description
   carries what a tool is for; an error carries what was missing and the call
   that recovers; a first-use block carries how to use the action well.
4. Find every other copy - other descriptions, `docs/messages.md`, the server
   instructions, `docs/instructions.md`, the skills - and remove it. A copy
   stays only as a pointer that itself sits at the moment.
5. Where the text repeats within a session, give it a ledger rule: once, or
   on change.
6. Where the fact steers a session off a worse path, count the requests each
   path takes. Fewer or equal: write the block. More: record the capability
   gap instead of the block.

Done when every fact the change touches has either gone to `docs/` or has
exactly one home at its moment, with what its absence produces named beside it,
every repeating text carries a ledger rule, and every worse-path block points
at a path of no more requests.

## Measuring a change

Claude Code transcripts (`~/.claude/projects/*/*.jsonl`) record every call,
reply, error and ToolSearch load, and each request's token usage. A change to
what sessions receive is checked against sessions run after it, compared with
sessions before it, on the measure the change aims at: requests per job,
repeated reply text per session, refusals followed by a stall, jobs done
another way while devharness was loaded, redone calls next to `replay
repeat`. A pattern count stands once a hand-read sample of its matches bounds
how many are real.
