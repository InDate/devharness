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

### How an agent learns devharness

The server's `instructions` field (`./mcp-instructions.md`) is sent to every client on connect, so it stays short and says what devharness is for. Each tool's description says what the tool is for, and the reply of an action's first use in a session, or the error a call meets, carries how to use it. The full reference for people is [`instructions.md`](./instructions.md), with the bench, the boundary and sequences in [`bench.md`](./bench.md), [`boundary.md`](./boundary.md) and [`sequences.md`](./sequences.md).

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
