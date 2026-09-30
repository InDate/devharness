# devharness Test Application

This is a test application with intentional bugs designed to validate devharness's debugging capabilities.

## Setup

```bash
npm install
npm run build
npm run dev
```

The application will start on `http://localhost:3000` with **Node.js debugging enabled on port 9229**.

## Using the Debugger

### For Browser Debugging (Challenges 1-7)

1. Launch Chrome with the MCP tool; the launch also connects the debugger:
   ```
   connection({ action: 'launch', name: "debugging payment flow", port: 9222, url: "http://localhost:3000" })
   ```

2. Start solving the challenges!

### For Full-Stack Debugging (Challenge 8)

Challenge 8 requires **both** Chrome AND Node.js connections:

1. **Chrome connection** (browser/client-side):
   ```
   connection({ action: 'launch', name: "debugging payment flow", port: 9222, url: "http://localhost:3000" })
   ```

2. **Node.js connection** (server-side):
   ```
   connection({ action: 'attach', name: "testing api endpoints", port: 9229 })
   // Returns: reference: "testing-api-endpoints", runtimeType: "node"
   ```

   Note: `npm run dev` automatically starts Node.js with `--inspect=9229` flag

3. **Manage connections**:
   ```
   connection({ action: 'list' })   // See both connections
   connection({ action: 'switch', connectionReason: "debugging-payment-flow" })  // Switch to Chrome
   connection({ action: 'switch', connectionReason: "testing-api-endpoints" })   // Switch to Node.js
   ```

4. **Important**: Breakpoints only work on the matching runtime:
   - Chrome connection → browser code (`public/client.js`)
   - Node.js connection → server code (`dist/index.js`)
   - Setting a breakpoint on server code while connected to Chrome will give a helpful error

## Debug Challenges

### Challenge 1: DOM Manipulation Bug 🎯
**Symptom**: "Fetch User" button doesn't respond to clicks
**Location**: `public/client.js` - `setupEventListeners()` (line 10)
**Bug**: Selector has typo: `.fetch-buttom` instead of `.fetch-button`

**Tools to Use**:
- `querySelector` with selector `".fetch-button"`
- `querySelector` with selector `".fetch-buttom"`
- `getDOMSnapshot()` to see actual elements
- `getElementProperties` with selector `"button"`
- `listConsoleLogs()` to see the error message

**Debugging Approach**:
1. Try clicking the "Fetch User" button - nothing happens
2. Check console logs for errors → see "ERROR: Fetch button not found!"
3. Use `querySelector('.fetch-button')` to verify the button exists in DOM
4. Look at the client.js code to find the typo in the event listener setup
5. Fix the typo by using `evaluateExpression` to manually attach the correct listener, or understand the bug

**Solution**: The event listener is looking for `.fetch-buttom` instead of `.fetch-button`

**Note**: Once you fix this (via console or by understanding it), the button will work and unlock Challenge 2!

---

### Challenge 2: Network Request Bug 🌐
**Symptom**: API returns 500 error even for valid requests
**Location**: `src/index.ts` - `/api/user/:id` endpoint
**Bug**: Server returns status 500 instead of 200 for successful requests

**Prerequisites**: Challenge 1 must be solved first so the button works!

**Tools to Use**:
- `enableNetworkMonitoring()` to capture requests
- Click the "Fetch User" button (now working after Challenge 1!)
- `listNetworkRequests()` or `searchNetworkRequests(pattern: "/api/user/.*")`
- `getNetworkRequest(id: "network-X")` to inspect details
- Set breakpoint in `handleFetchUser()` to inspect the response object
- Check `response.status` and `response.ok` values

**Debugging Approach**:
1. Enable network monitoring
2. Click "Fetch User" button
3. See request to `/api/user/1` returns status 500
4. Notice the UI still shows user data (bug!)
5. Set breakpoint in `handleFetchUser` function
6. Inspect `response` object → see `status: 500, ok: false`
7. Step through code → see it doesn't check `response.ok`

**Solution**: Client code doesn't check `response.ok` before processing JSON, so treats 500 errors as success

---

### Challenge 3 & 4: Console Errors & Variable Inspection 📋🐛
**Symptom**: Multiple error messages in console + array processing accesses undefined element
**Location**: `src/index.ts` - `/api/data` endpoint and `processItems()` function

**Challenge 3 - Console Error Tracking**:
**Tools to Use**:
- `searchConsoleLogs(pattern: "ERROR", flags: "i")`
- `listConsoleLogs(type: "error")`
- `getConsoleLog(id: "console-X")`

**Solution**: Use search to find all error messages and their locations

**Challenge 4 - Variable Inspection (Off-by-one)**:
**Symptom**: Array processing accesses undefined element
**Location**: `src/index.ts` - `processItems()` function (line 59)
**Bug**: Loop condition `i <= items.length` should be `i < items.length`

**Tools to Use**:
- `setBreakpoint` with URL `"file:///path/to/dist/index.js"` and lineNumber `59`
- `getCallStack()` when paused
- `getVariables` with callFrameId from call stack
- `evaluateExpression` with expression `"items.length"`
- `stepOver()` to see the bug happen

**Note on Source Maps**: Source maps are now auto-detected! When you connect to the debugger, the `scriptParsed` event automatically loads source maps if available. Check `connection({ action: 'status', connectionReason })` to see `sourceMapCount`.

**Solution**: Change loop condition from `<=` to `<`

---

### Challenge 5: localStorage Bug 💾
**Symptom**: Data stored but can't be retrieved
**Location**: `public/client.js` - `handleStorage()` (line 90)
**Bug**: Storing with key `usr_data` but retrieving with key `user_data`

**Tools to Use**:
- `getLocalStorage()` to see all keys
- `getLocalStorage` with key `"usr_data"`
- `getLocalStorage` with key `"user_data"`
- `setLocalStorage` to fix it

**Solution**: Use consistent key name for both storing and retrieving

---

### Challenge 6: Performance Issue 🐌
**Symptom**: Slow network request taking over 3 seconds
**Location**: `src/index.ts` - `/api/slow` endpoint
**Bug**: Artificial delay of 3000ms

**Tools to Use**:
- `searchNetworkRequests(pattern: "/api/slow")`
- `listNetworkRequests()` and check duration
- Filter requests by duration > 2000ms

**Solution**: Find the slow endpoint and identify the setTimeout causing delay

---

### Challenge 7: Secret Vault Password (Logpoints Required) 🔐
**Symptom**: Need to find the password that unlocks the vault, but it's never logged completely
**Location**: `src/index.ts` - `constructVaultPassword()`, `getAccessModifier()`, and `unlockVault()` functions
**Challenge Type**: Logpoint demonstration (not a bug)

**The Problem**:
The vault password is constructed dynamically across multiple functions and iterations:
- Base password is built character-by-character from 6 security tokens
- Access level modifier is added based on user's access level
- The complete password is NEVER logged or stored in a single visible place
- Password format: Base (6 chars) + Modifier (varies by level)

**Why Logpoints Required**:
- Regular breakpoints would require stopping execution 6+ times in the loop
- Logpoints allow non-intrusive observation of password construction
- Can observe multiple executions with different access levels efficiently
- Demonstrates the power of logpoints for data collection

**Tools to Use**:
- `setLogpoint` with:
  - url: `"file:///path/to/dist/index.js"`
  - lineNumber: `150`
  - logMessage: `"Char: {char}, Password so far: {password}"`
  - Set inside `constructVaultPassword()` loop to observe character-by-character construction
- `setLogpoint` with:
  - url: `"file:///path/to/dist/index.js"`
  - lineNumber: `162`
  - logMessage: `"Modifier: {modifier}"`
  - condition: `"level >= 2"`
  - Set in `getAccessModifier()` to see conditional modifier building
- `setLogpoint` with:
  - url: `"file:///path/to/dist/index.js"`
  - lineNumber: `184`
  - logMessage: `"Base: {basePassword}, Modifier: {modifier}"`
  - Set in `unlockVault()` to see final components before combination
- Use `listConsoleLogs()` to collect all logpoint outputs
- Try different access levels (1, 3, 5, 10) to see password variations

**Expected Passwords**:
- Access Level 1: `SPAbCD_L1`
- Access Level 3: `SPAbCD_L3`
- Access Level 5: `SPAbCD_L5_ADMIN`
- Access Level 10: `SPAbCD_L10_ADMIN`

**Learning Outcomes**:
1. When to use logpoints vs. breakpoints
2. How to set logpoints with expression interpolation
3. How to use conditional logpoints
4. Non-intrusive debugging for data collection
5. Observing iterative construction without pausing

**Solution**: Use logpoints at strategic locations to observe the password being constructed piece-by-piece, then reconstruct the complete password from console output

---

### Challenge 8: Multi-Connection Debugging 🔌

**Scenario**: Debug multiple applications simultaneously (Chrome browser + Node.js backend)
**Challenge Type**: Feature demonstration (not a bug)

**The Learning Goal**:
Learn how to manage multiple debugger connections at once - essential for full-stack debugging where you need to debug both frontend (browser) and backend (Node.js) simultaneously.

**Prerequisites**:
- Test app running with: `npm run dev` (server on port 3000, Node.js debugging on port 9229)
- Chrome launched with debugging: `connection({ action: 'launch', name: "debugging payment flow", port: 9222, url: "http://localhost:3000" })`

**REQUIRED for completion**: You MUST connect to BOTH Chrome AND Node.js to complete this challenge!

**Tools to Use**:
- `connection` action `launch` on port `9222` (Chrome) - REQUIRED
- `connection` action `attach` on port `9229` (Node.js) - REQUIRED
- `connection` action `list` to verify both connections - REQUIRED
- `connection` action `status` to check a connection (includes `reference`)
- `connection` action `switch` with `connectionReason` to change the active connection - REQUIRED
- Try setting a breakpoint on each runtime to see the difference

**Step-by-Step Approach** (ALL STEPS REQUIRED):
1. **Connect to Chrome** first:
   ```
   connection({ action: 'launch', name: "debugging payment flow", port: 9222, url: "http://localhost:3000" })
   ```
   - Verify response: `connectionReason: "debugging-payment-flow"`

2. **Connect to Node.js** server:
   ```
   connection({ action: 'attach', name: "testing api endpoints", port: 9229 })
   ```
   - Verify response: `reference: "testing-api-endpoints"`, `runtimeType: "node"`
   - Check features: `["debugging"]` only (no browser automation)
   - Note: This becomes the active connection automatically

3. **List all connections**:
   ```
   connection({ action: 'list' })
   ```
   - MUST show 2 connections
   - Verify one has `"type": "chrome"`, other has `"type": "node"`
   - Check which is `"active": true`

4. **Switch back to Chrome**:
   ```
   connection({ action: 'switch', connectionReason: "debugging-payment-flow" })
   ```
   - Verify active connection changed

5. **Test runtime separation** (try setting breakpoint on server code):
   ```
   setBreakpoint({ url: "http://localhost:3000/dist/index.js", lineNumber: 50 })
   ```
   - Should get helpful error: "You are connected to Chrome but trying to set breakpoint on server code"
   - This demonstrates you MUST switch to the Node.js connection for server breakpoints

6. **Switch to Node.js and try again**:
   ```
   connection({ action: 'switch', connectionReason: "testing-api-endpoints" })
   setBreakpoint({ url: "file:///path/to/test-app/dist/index.js", lineNumber: 50 })
   ```
   - Now it should work (or fail with different error if path is wrong)

7. **Verify understanding** by answering:
   - Why do I need 2 separate connections?
   - What happens if I try to use `takeScreenshot()` while connected to Node.js?
   - How do I check which connection is currently active?

**Key Concepts**:
- **Runtime Type Detection**: Chrome vs Node.js detected automatically
  - Chrome connections get: debugging + browser automation + console/network monitoring
  - Node.js connections get: debugging only (no DOM, screenshots, etc.)
- **Active Connection**: Tools operate on active connection unless `reference` specified
- **Connection Lifecycle**: Each connection has independent state (breakpoints, paused status, etc.)
- **Graceful Degradation**: Browser-only tools return helpful errors for Node.js connections

**Expected Behavior**:
- First connection automatically becomes active
- Switching changes which connection receives commands
- Each connection maintains independent debugging state
- Can set breakpoints in both environments, switch between them during execution

**Learning Outcomes**:
1. How to debug frontend and backend simultaneously
2. Understanding runtime type detection and feature availability
3. Managing multiple debugger connections efficiently
4. When to use `reference` parameter vs active connection

---

## Validation Checklist

- [ ] Challenge 1: Found DOM selector typo using querySelector and console logs
- [ ] Challenge 2: Found 500 status code in network requests using runtime debugging
- [ ] Challenge 3: Searched and found all ERROR messages in console
- [ ] Challenge 4: Set breakpoint, inspected variables, found off-by-one bug
- [ ] Challenge 5: Inspected localStorage and found key mismatch
- [ ] Challenge 6: Found slow request using network search
- [ ] Challenge 7: Used logpoints to discover vault password construction
- [ ] Challenge 8: Connected to BOTH Chrome AND Node.js, used connection list, switched between connections, and tested runtime separation

## Success Criteria

All 8 challenges should be solvable using only the MCP debugger tools without:
- Reading the source code directly
- Using browser DevTools manually
- Guessing the solutions

The debugger should provide all necessary information to identify and understand each bug.

**Challenge Flow**: Challenges 1 and 2 are sequential - Challenge 1 (DOM bug) must be solved before Challenge 2 (network bug) can be properly tested, as they share the same button.
