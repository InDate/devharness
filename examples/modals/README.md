# Examples

This directory contains an example file for testing and demonstrating devharness.

## Files

### modal-test.html

A test page demonstrating modal/overlay detection and handling. Features:
- Cookie consent banner overlay
- Multiple dismissal strategies (accept, reject, close)
- Tests for automatic modal handling during browser automation

**Usage:**
1. Launch Chrome via the debugger: `connection({ action: 'launch', name: 'modals' })`
2. Navigate to this file: `navigate({ action: 'goto', connectionReason: 'modals', url: "file:///path/to/examples/modal-test.html" })`
3. Test modal detection: `modal({ action: 'detect', connectionReason: 'modals' })`
4. Test automatic handling: `input({ action: 'click', connectionReason: 'modals', selector: "#testButton", handleModals: true })`

## Adding Examples

When adding new examples:
1. Include clear documentation in comments
2. Add a description to this README
3. Keep examples simple and focused on specific features
4. Test examples before committing
