# devharness Documentation

Chrome DevTools Protocol tools for AI-assisted debugging and browser automation.

## Why Use devharness?

Instead of just analyzing static code, AI assistants can now:
- **Debug running applications in real-time** - Set breakpoints and inspect live state
- **Observe actual runtime behavior** - See how your code actually executes
- **Test and validate fixes immediately** - Make changes and verify them instantly
- **Automate browser interactions** - Test UI flows and capture issues
- **Provide insights based on live execution data** - Understand complex runtime scenarios

## Documentation

| Guide | Description |
|-------|-------------|
| [Installation](./installation.md) | Setup for Claude Code, Claude Desktop, and from source |
| [Debugging](./debugging.md) | Breakpoints, stepping, variables, call stacks, source maps |
| [Automation](./automation.md) | Navigation, element interaction, screenshots, storage, server management |
| [Replay](./replay.md) | Record interactions, replay sequences, export Playwright/Puppeteer tests |
| [Troubleshooting](./troubleshooting.md) | Common issues and solutions |
| [API Reference](./instructions.md) | Full tool reference and best practices (human-readable) |
| [Message Templates](./messages.md) | Response format templates |

### Agent Skill

This package also ships an [Agent Skills](https://agentskills.io)-compatible skill at [`skills/devharness/`](../skills/devharness/SKILL.md), containing the same guidance as the API Reference above but structured for progressive disclosure. Copy or symlink it into a scanned skills directory (e.g. `.claude/skills/devharness` or `.agents/skills/devharness`) so Agent-Skills-aware clients load it only when a debugging task is actually underway, instead of paying the full token cost every session. The MCP server's own `instructions` field (`./mcp-instructions.md`) stays intentionally short for this reason - it's sent to every client on connect, whether or not that client supports Agent Skills.

You don't have to set this up by hand: on startup, the server checks whether the skill is already installed anywhere a client would scan for it (project- or user-level, `.claude/skills/` or `.agents/skills/`). If it isn't found, the `instructions` payload asks the connected agent to offer installing it - the agent will propose the symlink command and only run it if you agree. Once installed, this nudge stops appearing.

## Quick Start

```bash
# Claude Code CLI
claude mcp add devharness -- npx -y devharness
```

```javascript
// Launch Chrome and start debugging
connection({ action: 'launch', connection: 'my debug session' })
navigate({ action: 'goto', url: 'http://localhost:3000', connection: 'my-debug-session' })

// Set a breakpoint
breakpoint({ action: 'set', url: 'http://localhost:3000/app.js', lineNumber: 42, connection: 'my-debug-session' })

// When paused, inspect state
inspect({ action: 'getCallStack', connection: 'my-debug-session' })
inspect({ action: 'getVariables', callFrameId: '0', connection: 'my-debug-session' })
```

## Core Concepts

### Connection Management

devharness supports multiple simultaneous connections:

- **Chrome connections**: Each browser tab can have its own connection
- **Node.js connections**: Debug backend applications separately
- **Connection references**: Use descriptive 3-word names (e.g., "user profile page")

### Smart Element Caching

When you navigate to a page, devharness automatically:

1. **Caches all clickable elements** - Links, buttons, and inputs are discovered and stored
2. **Records viewport positions** - Tracks which elements are visible
3. **Enables instant filtering** - Search cached elements without re-querying the DOM
4. **Expires after 5 minutes** - Fresh data on subsequent navigations

## Need Help?

- Try the [Test Application](../examples/test-app/README.md) for hands-on practice
- File issues at https://github.com/InDate/devharness/issues
