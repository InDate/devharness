# devharness

[![npm version](https://img.shields.io/npm/v/devharness.svg)](https://www.npmjs.com/package/devharness)
[![license](https://img.shields.io/npm/l/devharness.svg)](https://github.com/InDate/devharness/blob/main/LICENSE)

**Let Claude open your app, use it, and see what actually goes wrong.**

When you build with an AI agent, you end up as its tester. It changes the code,
then you open the browser, click through, and paste the error back. It can't see
the page, the browser console or your server's output, so it works from what you
paste, and "fixed" often isn't.

devharness gives the agent its own Chrome window. It opens your app, clicks and
types like you would, reads the errors in the console and the server logs, and
can try its own fix in the browser before telling you it's done.

```
/plugin marketplace add InDate/indate-tools
/plugin install devharness@indate-tools
```

> Was `cdp-tools-mcp`. [Migrating](#migrating).

## What you'll notice

- **A Chrome window opens and the agent uses your app.** You can watch it
  navigate, fill forms and click buttons. It runs with its own temporary profile,
  so your everyday browser, bookmarks and logins are untouched.
- **The agent sees errors without you pasting them.** After each action it gets
  any new output from your dev server and the newest error in the browser
  console, with where it came from.
- **The agent runs your dev server.** It can start it, restart it and read its
  logs. With port monitoring on, a server that dies stops browser actions with a
  message saying so, rather than the agent clicking away at a dead page and
  reporting made-up results.
- **Setup isn't redone by hand.** Every action gets a number. To get back to the
  broken screen after a fix, the agent re-runs those numbered steps in one call,
  with exactly the values it used the first time.

## Things to ask

Ask for the outcome. The agent picks the tools.

- "Open the app at localhost:3000 and check the signup form works."
- "The total on the checkout page is wrong. Find where it's calculated."
- "Start the dev server and keep an eye on it while we work."
- "Click through the settings page and tell me which buttons do nothing."
- "Record the steps that reproduce this bug, then re-run them after you fix it."

## Show it the problem instead of describing it

Some bugs are hard to put into words: "the thing on the right, under the header,
is too far down". Ask the agent to open the **bench**, and a panel opens beside
your app. Click the element you mean and type a note, and attach a screenshot
you can crop and draw on. The note records what the element is -
its selector, and its component and source file where your dev build exposes
them - and reaches the agent as soon as you save it.

## Keep a bug and prove the fix

The steps the agent takes can be saved as a **sequence** and replayed later, or
exported as a Playwright or Puppeteer test. An **issue** can carry the sequence
that reproduces it, so working on it starts by replaying to the broken state.

Closing an issue needs you. The agent opens a Fixed / Not Fixed prompt in the
browser and waits for your click; it can record what it found, but it can't mark
its own work as fixed. Issues can be published to GitHub, which shows you a
draft and posts nothing until you confirm.

## Setup

You need **Google Chrome** installed in its usual place and **Node.js 18** or
later.

**Claude Code** (recommended) - the plugin registers the server, adds the skill
that teaches the agent how to use it, and pins the version, so what you installed
is what runs until you update:

```
/plugin marketplace add InDate/indate-tools
/plugin install devharness@indate-tools
```

**Claude Code, server only:**
```bash
claude mcp add devharness -- npx devharness@latest
```

**Claude Desktop:**
```json
{
  "mcpServers": {
    "devharness": {
      "command": "npx",
      "args": ["-y", "devharness@latest"]
    }
  }
}
```

**Other MCP clients:** run `npx devharness@latest` over stdio.

Without the plugin, link the skill into your project so the agent gets the same
guidance:

```bash
mkdir -p .claude/skills
ln -s ../../node_modules/devharness/plugin/skills/devharness .claude/skills/devharness
```

## For developers

devharness is an [MCP](https://modelcontextprotocol.io) server that drives Chrome
and Node.js through the Chrome DevTools Protocol. Beyond the above:

- **Debugger.** Breakpoints (line, conditional, logpoints, DOM changes, events,
  XHR), stepping, the call stack and variables in scope, in Chrome and in Node.js
  started with `--inspect`, both at once. Source maps put TypeScript
  breakpoints on TypeScript lines.
- **Page checks.** `content verify` reports dead buttons, dead links, small touch
  targets, clipped overflow and horizontal scroll, from what the browser reports.
- **Network.** Console, requests and responses, cookies and storage. With
  `launchChrome({ proxy: true })` the browser runs through a recording proxy that
  ties each request and socket message to the step that caused it and keeps the
  app's own polling apart.
- **Dev servers.** npm scripts, Docker and Docker Compose.
  `start({ monitorPort: true })` watches the port and blocks browser tools while
  it is down; `start({ watch: true })` restarts on file changes.
- **Several agents.** Every tool takes a named connection, so nested agents each
  drive their own tab in one Chrome, and sessions can message each other.
- **Recovery.** A call missing a field returns what is missing and the retry sends
  only that. `config({ action: 'restart' })` respawns a stuck server without the
  client reconnecting.

A Node service by hand:

```
1. node --inspect=9229 app.js
2. connectDebugger({ reference: "api", port: 9229 })
3. breakpoint({ action: 'set', connectionReason: "api", file: "user.ts", line: 42 })
4. Trigger the request.
5. inspect({ action: 'getVariables', connectionReason: "api" })
```

[examples/test-app](./examples/test-app/README.md) is an app with deliberate bugs
to practise on.

### Command line

`devharness <command>`, run from a shell inside an editor session, executes a tool in that session's own server process, against the browser and dev servers it already has open. Only sessions rooted at the shell's directory or above it are candidates, because issues, config and sequences resolve against the answering server's root; process ancestry picks among those. Nothing needs to be passed in.

```sh
devharness which                                  # which session this shell belongs to
devharness call config '{"action":"status"}'      # any tool, arguments as one JSON object
devharness sessions                               # who else is reachable
devharness send a1b2c3d4 "check this" --wait=60000
devharness bug "Title" Body words here            # files an issue; feature does the same
devharness bench [sequence] [url]                 # opens the bench against this session
```

`--session=<id>` targets a session explicitly, `--json` prints the unrendered response, and the exit code is 1 when the tool returns an error. Each session listens on a unix socket under `~/.devharness/endpoints/`, mode 0600 - not a TCP port, because the tools reachable through it evaluate JavaScript in that session's browser.

`devharness run <sequenceName>` is separate: it starts its own headless Chrome and replays a saved sequence, with no session involved.

### Documentation

- [docs/README.md](./docs/README.md): guides for installation, debugging,
  automation, replay and troubleshooting
- [docs/instructions.md](./docs/instructions.md): every tool and action
- [CHANGELOG.md](./CHANGELOG.md): what each release changed

## Migrating

`cdp-tools-mcp` is deprecated on npm and points here. Tools unchanged. Package,
repo, and skill renamed.

```diff
-"args": ["-y", "cdp-tools-mcp@latest"]
+"args": ["-y", "devharness@latest"]
```

Your MCP server name (`devharness`, or whatever you called it) is yours and keeps
working. Renaming it is cosmetic — but tools are addressed as
`mcp__<server-name>__<tool>`, so update project docs if you do.

State moved `.cdp-tools/` → `.devharness/` in 0.9.0. Migrates itself on first
run; profiles, config, sequences, and issues carry over. `DEVHARNESS_DIR`
supersedes `CDP_TOOLS_DIR`, which still works.

## From source

```bash
git clone https://github.com/InDate/devharness.git
cd devharness
npm install && npm run build && npm test
```

## Contributing

Issues and PRs welcome. Reporting a bug? Attach a recorded reproduction sequence.

## License

MIT
