#!/usr/bin/env node

/**
 * Test script to verify MCP server loads and registers tools correctly
 * Run this after building to catch schema issues before deployment
 * Also measures token usage for tool definitions
 */

import { spawn } from 'child_process';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const TIMEOUT_MS = 10000;

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..');

/**
 * Docs that claim to enumerate the tool surface. These ship to users - the
 * Agent Skill's catalog is loaded by clients that support Agent Skills, and
 * docs/instructions.md is the same material inline for clients that don't.
 * A stale catalog is worse than no catalog: it sends an agent confidently
 * after tools that do not exist.
 */
const TOOL_SURFACE_DOCS = [
  'plugin/skills/devharness/references/tool-categories.md',
  'docs/instructions.md',
];

/**
 * Tool names documented in a catalog file.
 *
 * Tools appear either as a bolded group with an action list -
 * `**Storage**: \`storage\` (actions: ...)` - or as bare backticked names in a
 * category bullet. Both forms are just inline code spans on a `**Category**:`
 * line, so collect every code span on those lines and intersect with the live
 * tool list rather than trying to parse prose. Anything that isn't a real tool
 * name (an action, a param, a path) simply won't intersect.
 */
function documentedToolNames(markdown) {
  const found = new Set();

  for (const line of markdown.split('\n')) {
    if (!/^\*\*[^*]+\*\*:/.test(line)) continue;
    for (const match of line.matchAll(/`([^`]+)`/g)) {
      const token = match[1].trim();
      // Only bare identifiers are tool names; a code span containing a space,
      // dot, brace or paren is a call example or a config key, not a name.
      if (/^[A-Za-z][A-Za-z0-9]*$/.test(token)) found.add(token);
    }
  }

  return found;
}

/**
 * Fail the build when the shipped catalogs and the real tool surface disagree.
 *
 * This exists because the catalog silently rotted once already: it described a
 * pre-grouping API (navigateTo, clickElement, takeScreenshot) long after the
 * tools had been consolidated into grouped ones, and nothing caught it because
 * a stale doc still builds and still passes tests.
 */
/**
 * A grouped tool's description lists its actions in prose: "Actions: run
 * (...), step (...)". That prose is what an agent actually reads when choosing
 * a call, and it rots independently of the schema - the replay tool advertised
 * save/startMouseRecording/stopMouseRecording/mouseRecordingStatus long after
 * all four were removed from its enum, so agents were being pointed at calls
 * that could only fail. Every `name (` mentioned after "Actions:" must exist
 * in that tool's own action enum.
 */
function verifyDescribedActions(tools) {
  let ok = true;

  for (const tool of tools) {
    const actions = tool.inputSchema?.properties?.action?.enum;
    if (!Array.isArray(actions)) continue;

    const described = tool.description?.match(/Actions?:\s*([\s\S]*)$/)?.[1];
    if (!described) continue;

    const valid = new Set(actions);
    const phantom = [...new Set(
      [...described.matchAll(/([A-Za-z][A-Za-z0-9]*)\s*\(/g)].map((m) => m[1])
    )].filter((name) => !valid.has(name));

    if (phantom.length > 0) {
      console.error(`✗ ${tool.name} description advertises ${phantom.length} action(s) not in its schema: ${phantom.join(', ')}`);
      ok = false;
    }
  }

  if (ok) console.log('✓ Tool descriptions only advertise actions that exist');
  return ok;
}

/**
 * The skill's stamped version is what lets the server spot an installed copy
 * left behind by an older release. If it drifts from package.json the stamp
 * silently stops meaning anything, so treat a mismatch as a build failure.
 */
function verifySkillVersionStamp() {
  try {
    const pkgVersion = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf-8')).version;
    const skill = readFileSync(join(REPO_ROOT, 'plugin/skills/devharness/SKILL.md'), 'utf-8');
    const stamped = skill.match(/^version:\s*(.+)$/m)?.[1].trim();

    if (!stamped) {
      console.error('✗ plugin/skills/devharness/SKILL.md has no `version:` in its frontmatter');
      return false;
    }
    if (stamped !== pkgVersion) {
      console.error(`✗ SKILL.md is stamped ${stamped} but package.json is ${pkgVersion} - bump the skill stamp`);
      return false;
    }

    console.log(`✓ SKILL.md version stamp matches package.json (${pkgVersion})`);

    // .mcp.json is the plugin manifest that ships to users: it is what their
    // install actually runs. Pinned deliberately rather than @latest, which
    // makes it a third place the version has to be bumped - so check it here
    // rather than discover it after a release installs the wrong build.
    const mcp = JSON.parse(readFileSync(join(REPO_ROOT, 'plugin/.mcp.json'), 'utf-8'));
    const args = mcp.mcpServers?.devharness?.args ?? [];
    const spec = args.find((a) => a.startsWith('devharness@'));
    if (!spec) {
      console.error('✗ plugin/.mcp.json does not pin a devharness@<version> package spec');
      return false;
    }
    const pinned = spec.split('@')[1];
    if (pinned !== pkgVersion) {
      console.error(`✗ plugin/.mcp.json installs devharness@${pinned} but package.json is ${pkgVersion} - bump the pin`);
      return false;
    }
    console.log(`✓ plugin/.mcp.json pins devharness@${pinned}`);
    return true;
  } catch (error) {
    console.error(`✗ Cannot verify version stamps: ${error.message}`);
    return false;
  }
}

/**
 * Docs that show tool calls in prose rather than enumerating the surface.
 * These are not checked for coverage - a guide has no duty to mention every
 * action - but every call they *do* show must be real.
 */
const CALL_EXAMPLE_DOCS = [
  'plugin/skills/devharness/references/sequences.md',
  'plugin/skills/devharness/SKILL.md',
];

/**
 * Fail on a documented `tool({ action: 'x' })` whose action does not exist.
 *
 * The enumerating catalogs are already gated, but the guides were not, and
 * they carry the most call examples - sequences.md alone is 31KB of them.
 * A wrong action in a guide is worse than a stale catalog: an agent copies
 * the call verbatim and it fails at runtime.
 */
function verifyDocumentedCalls(tools) {
  const actionsByTool = new Map();
  for (const tool of tools) {
    const actions = tool.inputSchema?.properties?.action?.enum;
    if (Array.isArray(actions)) actionsByTool.set(tool.name, new Set(actions));
  }

  let ok = true;

  for (const relPath of CALL_EXAMPLE_DOCS) {
    let markdown;
    try {
      markdown = readFileSync(join(REPO_ROOT, relPath), 'utf-8');
    } catch (error) {
      console.error(`✗ Cannot read ${relPath}: ${error.message}`);
      ok = false;
      continue;
    }

    const bad = [];
    let checked = 0;
    // `tool({ action: 'name' ...` - the shape every call example uses.
    for (const [, tool, action] of markdown.matchAll(/(\w+)\(\{\s*action:\s*['"]([A-Za-z][A-Za-z0-9]*)['"]/g)) {
      const known = actionsByTool.get(tool);
      if (!known) continue;   // not a grouped tool of ours; nothing to check
      checked++;
      if (!known.has(action)) bad.push(`${tool}({ action: '${action}' })`);
    }

    if (bad.length > 0) {
      const unique = [...new Set(bad)];
      console.error(`✗ ${relPath} shows ${unique.length} call(s) with actions that do not exist: ${unique.join(', ')}`);
      ok = false;
    } else {
      console.log(`✓ ${relPath} - all ${checked} documented calls use real actions`);
    }
  }

  return ok;
}

function verifyDocumentedToolSurface(liveToolNames) {
  let ok = verifySkillVersionStamp();

  for (const relPath of TOOL_SURFACE_DOCS) {
    let markdown;
    try {
      markdown = readFileSync(join(REPO_ROOT, relPath), 'utf-8');
    } catch (error) {
      console.error(`✗ Cannot read tool-surface doc ${relPath}: ${error.message}`);
      ok = false;
      continue;
    }

    const live = new Set(liveToolNames);
    const documented = documentedToolNames(markdown);

    const undocumented = liveToolNames.filter((name) => !documented.has(name));
    // The direction that actually rotted: names the doc still advertises after
    // the tool was renamed or consolidated away. An agent reading these calls
    // a tool that does not exist.
    const phantom = [...documented].filter((name) => !live.has(name));

    if (undocumented.length > 0) {
      console.error(`✗ ${relPath} does not document ${undocumented.length} live tool(s): ${undocumented.join(', ')}`);
      ok = false;
    }
    if (phantom.length > 0) {
      console.error(`✗ ${relPath} documents ${phantom.length} tool(s) that no longer exist: ${phantom.join(', ')}`);
      ok = false;
    }
    if (undocumented.length === 0 && phantom.length === 0) {
      console.log(`✓ ${relPath} matches all ${liveToolNames.length} live tools`);
    }
  }

  return ok;
}

/**
 * Estimate token count for a string using cl100k_base approximation
 * ~4 characters per token for English text, ~3 for JSON/code
 * This is a rough estimate - actual tokenization varies
 */
function estimateTokens(text) {
  if (!text) return 0;
  const str = typeof text === 'string' ? text : JSON.stringify(text);
  // JSON/code tends to be ~3 chars per token due to punctuation
  // But descriptions are ~4 chars per token
  // Use 3.5 as a middle ground
  return Math.ceil(str.length / 3.5);
}

/**
 * Calculate detailed token breakdown for a tool
 */
function analyzeToolTokens(tool) {
  const nameTokens = estimateTokens(tool.name);
  const descTokens = estimateTokens(tool.description);
  const schemaTokens = estimateTokens(tool.inputSchema);

  return {
    name: tool.name,
    total: nameTokens + descTokens + schemaTokens,
    breakdown: {
      name: nameTokens,
      description: descTokens,
      schema: schemaTokens
    },
    chars: {
      name: tool.name?.length || 0,
      description: tool.description?.length || 0,
      schema: JSON.stringify(tool.inputSchema)?.length || 0
    }
  };
}

console.log('Testing MCP server tool registration...');

const serverProcess = spawn('node', ['build/index.js'], {
  stdio: ['pipe', 'pipe', 'pipe']
});

let hasReceivedResponse = false;
let hasError = false;
let buffer = '';

serverProcess.stdout.on('data', (data) => {
  buffer += data.toString();

  // Try to parse each line as JSON
  const lines = buffer.split('\n');
  buffer = lines.pop() || ''; // Keep incomplete line in buffer

  for (const line of lines) {
    if (!line.trim()) continue;

    try {
      const parsed = JSON.parse(line);

      // Check if it's a response to our tools/list request
      if (parsed.result && parsed.result.tools && Array.isArray(parsed.result.tools)) {
        hasReceivedResponse = true;
        const tools = parsed.result.tools;
        const toolCount = tools.length;
        console.log(`✓ Successfully registered ${toolCount} tools`);

        // Verify key tools exist
        const toolNames = tools.map(t => t.name);
        const keyTools = ['connection', 'navigate', 'breakpoint', 'replay'];
        const missing = keyTools.filter(t => !toolNames.includes(t));

        if (missing.length > 0) {
          console.error('✗ Missing expected tools:', missing.join(', '));
          serverProcess.kill();
          process.exit(1);
        }

        console.log('✓ All key tools registered');

        // Shipped catalogs must match the real surface (see comment above).
        const surfaceOk = verifyDocumentedToolSurface(toolNames);
        const actionsOk = verifyDescribedActions(tools);
        const callsOk = verifyDocumentedCalls(tools);
        if (!surfaceOk || !actionsOk || !callsOk) {
          console.error('');
          console.error('✗ Shipped tool documentation is out of sync with the registered tools.');
          console.error('  Update the files listed above, then re-run. These ship to users.');
          serverProcess.kill();
          process.exit(1);
        }

        // Token analysis
        const toolAnalysis = tools.map(analyzeToolTokens);
        const totalTokens = toolAnalysis.reduce((sum, t) => sum + t.total, 0);
        const totalChars = toolAnalysis.reduce((sum, t) =>
          sum + t.chars.name + t.chars.description + t.chars.schema, 0);

        // Sort by token usage
        const sortedByTokens = [...toolAnalysis].sort((a, b) => b.total - a.total);

        console.log('');
        console.log('=== Tool Token Analysis ===');
        console.log(`Total estimated tokens: ${totalTokens.toLocaleString()}`);
        console.log(`Total characters: ${totalChars.toLocaleString()}`);
        console.log(`Average tokens per tool: ${Math.round(totalTokens / toolCount)}`);
        console.log('');
        console.log('Top 10 tools by token usage:');
        for (const tool of sortedByTokens.slice(0, 10)) {
          console.log(`  ${tool.name}: ${tool.total} tokens (desc: ${tool.breakdown.description}, schema: ${tool.breakdown.schema})`);
        }

        // Category breakdown
        const descTokens = toolAnalysis.reduce((sum, t) => sum + t.breakdown.description, 0);
        const schemaTokens = toolAnalysis.reduce((sum, t) => sum + t.breakdown.schema, 0);
        console.log('');
        console.log('Breakdown by category:');
        console.log(`  Descriptions: ${descTokens.toLocaleString()} tokens (${Math.round(descTokens/totalTokens*100)}%)`);
        console.log(`  Schemas: ${schemaTokens.toLocaleString()} tokens (${Math.round(schemaTokens/totalTokens*100)}%)`);

        console.log('');
        console.log('✓ MCP server is healthy');
        serverProcess.kill();
        process.exit(0);
      }
    } catch (e) {
      // Not JSON, ignore
    }
  }
});

serverProcess.stderr.on('data', (data) => {
  const str = data.toString();
  // Look for port reservation which indicates successful startup
  if (str.includes('Reserved debug port')) {
    console.log('✓ MCP server started successfully');

    // Now send the tools/list request
    const request = {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/list'
    };

    serverProcess.stdin.write(JSON.stringify(request) + '\n');
  }
});

serverProcess.on('error', (err) => {
  console.error('✗ Failed to start MCP server:', err.message);
  hasError = true;
  process.exit(1);
});

serverProcess.on('exit', (code, signal) => {
  if (!hasReceivedResponse && !hasError) {
    console.error('✗ MCP server exited unexpectedly');
    process.exit(1);
  }
});

// Timeout check
setTimeout(() => {
  if (!hasReceivedResponse && !hasError) {
    console.error('✗ Test timed out - MCP server may have hung during startup');
    console.error('This often indicates a schema issue preventing tool registration');
    serverProcess.kill();
    process.exit(1);
  }
}, TIMEOUT_MS);
