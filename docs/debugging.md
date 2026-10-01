# Runtime Debugging

## Setting Breakpoints

**Regular breakpoints:**
```javascript
breakpoint({
  action: 'set',
  url: 'http://localhost:3000/app.js',
  lineNumber: 42,
  connection: 'my-debug-session'
})
```

**Conditional breakpoints:**
```javascript
breakpoint({
  action: 'set',
  url: 'http://localhost:3000/app.js',
  lineNumber: 42,
  condition: 'userId === "123"',
  connection: 'my-debug-session'
})
```

**Logpoints** (non-breaking):
```javascript
breakpoint({
  action: 'setLogpoint',
  url: 'http://localhost:3000/app.js',
  lineNumber: 42,
  logMessage: 'User {userId} with role {userRole}',
  includeCallStack: true,
  maxExecutions: 50,
  connection: 'my-debug-session'
})
```

## Execution Control

When paused at a breakpoint:

```javascript
// Get call stack
inspect({ action: 'getCallStack', connection: 'my-debug-session' })

// Get variables in current scope
inspect({ action: 'getVariables', callFrameId: '0', connection: 'my-debug-session' })

// Filter variables by name pattern
inspect({ action: 'getVariables', callFrameId: '0', filter: 'user|config', connection: 'my-debug-session' })

// Evaluate expression
inspect({ action: 'evaluateExpression', expression: 'user.email', connection: 'my-debug-session' })

// Step over
execution({ action: 'stepOver', connection: 'my-debug-session' })

// Step into
execution({ action: 'stepInto', connection: 'my-debug-session' })

// Step out
execution({ action: 'stepOut', connection: 'my-debug-session' })

// Resume
execution({ action: 'resume', connection: 'my-debug-session' })
```

## Source Maps

TypeScript debugging works automatically:

1. Source maps are auto-detected and registered for lazy loading
2. Breakpoints map to original TypeScript files
3. Variable names match your source code
4. Call stacks show TypeScript file paths

**Lazy Loading**: Source maps are loaded on-demand when needed (e.g., when mapping positions), not eagerly at startup. This improves performance with large codebases.

**Size Limits**: To prevent performance issues:
- Inline source maps (data URIs): 1MB max
- File-based source maps: 10MB max

**Manual Loading**:
```javascript
// Register source maps from a directory (lazy - does not load immediately)
source({ action: 'loadMaps', directory: './dist' })

// Source maps load automatically when you:
// - Set a breakpoint that needs mapping
// - Get original position from generated code
```

## Code Search

Search for patterns in loaded scripts:

```javascript
// Search for code patterns
inspect({
  action: 'searchCode',
  pattern: 'fetchUser',
  urlFilter: 'localhost',
  connection: 'my-debug-session'
})

// Find function definitions
inspect({
  action: 'searchFunctions',
  functionName: 'handleSubmit',
  connection: 'my-debug-session'
})

// Get source code at specific lines
source({
  action: 'get',
  url: 'http://localhost:3000/app.js',
  startLine: 40,
  endLine: 60,
  connection: 'my-debug-session'
})
```

**Webpack Support**: When using webpack with eval-based source maps, code search automatically extracts the actual source code from webpack's eval wrappers.

## Node.js Debugging

Debug backend applications:

```bash
# Start Node with debugging
node --inspect=9229 server.js
```

```javascript
// Connect to Node.js debugger
connection({ action: 'attach', connection: 'backend debug session', port: 9229 })

// Set breakpoints
breakpoint({
  action: 'set',
  url: 'file:///app/server.js',
  lineNumber: 50,
  connection: 'backend-debug-session'
})
```

## Multi-Runtime Debugging

Debug Chrome and Node.js simultaneously:

**Chrome:**
```javascript
connection({ action: 'launch', connection: 'frontend debug session' })
navigate({ action: 'goto', url: 'http://localhost:3000', connection: 'frontend-debug-session' })
```

**Node.js (separate connection):**
```javascript
connection({ action: 'attach', connection: 'backend debug session', port: 9229 })
breakpoint({ action: 'set', url: 'file:///app/server.js', lineNumber: 50, connection: 'backend-debug-session' })
```

## Logpoint Expressions

Logpoints support variable interpolation:

```javascript
// Simple variables
logMessage: 'User ID: {userId}'

// Object properties
logMessage: 'User: {user.email}, Role: {user.role}'

// Function calls
logMessage: 'Timestamp: {Date.now()}'

// Complex expressions
logMessage: 'Cart total: {cart.items.reduce((sum, item) => sum + item.price, 0)}'
```

## Variable Inspection Fallbacks

When debugging code with many variables or deeply nested objects, `getVariables` automatically degrades gracefully to fit within token limits:

1. **Full data** at requested depth (ideal case)
2. **Depth reduced** - automatically reduce expansion depth
3. **Names only** - variable names grouped by scope
4. **Counts only** - scope counts as last resort

To inspect specific variables at full depth, use `filter` or `evaluateExpression`:

```javascript
// Filter to specific variable
inspect({ action: 'getVariables', callFrameId: '0', filter: '^myVar$', connection: 'my-debug-session' })

// Or evaluate directly
inspect({ action: 'evaluateExpression', expression: 'myVar', connection: 'my-debug-session' })
```

## Bug Hunting Pattern

1. **Launch and navigate**
```javascript
connection({ action: 'launch', connection: 'bug hunt session' })
navigate({ action: 'goto', url: 'http://localhost:3000/problematic-page', connection: 'bug-hunt-session' })
```

2. **Monitor console errors**
```javascript
console({ action: 'list', type: 'error', connection: 'bug-hunt-session' })
```

3. **Set breakpoints**
```javascript
breakpoint({
  action: 'set',
  url: 'http://localhost:3000/app.js',
  lineNumber: 150,
  connection: 'bug-hunt-session'
})
```

4. **Trigger the bug and inspect**
```javascript
input({ action: 'click', selector: '#trigger-button', connection: 'bug-hunt-session' })
// Pauses at breakpoint
inspect({ action: 'getCallStack', connection: 'bug-hunt-session' })
inspect({ action: 'getVariables', callFrameId: '0', connection: 'bug-hunt-session' })
```
