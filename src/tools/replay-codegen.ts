/**
 * Playwright and Puppeteer test code generated from a sequence's steps.
 */
import { sanitizeReference } from '../reference-validator.js';
import { analyzeRecordedStepConnections } from './replay-executor.js';

/**
 * Escape a string for use in JavaScript code generation
 * Handles newlines, quotes, backslashes, and other special characters
 */
function escapeJsString(str: string): string {
  return str
    .replace(/\\/g, '\\\\')   // Backslashes first
    .replace(/'/g, "\\'")      // Single quotes
    .replace(/\n/g, '\\n')     // Newlines
    .replace(/\r/g, '\\r')     // Carriage returns
    .replace(/\t/g, '\\t');    // Tabs
}

/** A recorded value as a single-quoted JavaScript string literal. */
function jsString(value: unknown): string {
  return `'${escapeJsString(String(value))}'`;
}

/**
 * One page variable per recorded connection, for the code generators.
 *
 * A sequence that drove two browsers has to generate two pages: emitting every
 * step against a single `page` is the bug-018 collapse relocated into the
 * exported test, and it is silent - the generated file looks perfectly
 * reasonable and passes while never involving the second browser. The first
 * recorded reference keeps the name `page`, so single-connection output names
 * only `page`.
 */
function buildPageVars(commands: Array<{ tool: string; params: Record<string, any> }>) {
  const { references, mixed } = analyzeRecordedStepConnections(commands);
  const vars = new Map<string, string>();
  references.forEach((ref, i) => {
    vars.set(ref, i === 0
      ? 'page'
      : 'page' + ref.split(/[^a-zA-Z0-9]+/).filter(Boolean).map(w => w[0].toUpperCase() + w.slice(1)).join(''));
  });
  return {
    references,
    mixed,
    multi: references.length > 1,
    /** The page a step runs against; bare steps fall back to the first page. */
    varFor: (cmd: { params: Record<string, any> }) =>
      (typeof cmd.params.connectionReason === 'string' && vars.get(sanitizeReference(cmd.params.connectionReason))) || 'page',
    /** `page` is declared by the caller's preamble; these are the extras. */
    extras: references.slice(1).map(ref => ({ ref, name: vars.get(ref)! })),
  };
}

/**
 * Retarget the lines a single command emitted onto its own page variable.
 * Done as a post-pass over the emitted slice so the (long, per-tool) generator
 * bodies stay untouched and keep emitting the plain `page`.
 */
function rewritePage(lines: string[], from: number, pageVar: string): void {
  if (pageVar === 'page') return;
  for (let i = from; i < lines.length; i++) {
    lines[i] = lines[i].replace(/\bpage\b/g, pageVar);
  }
}

/** Header explaining a multi-browser export, so the collapse can't happen quietly. */
function generatedCodeHeader(pages: ReturnType<typeof buildPageVars>): string[] {
  if (!pages.multi) return [];
  const out = [
    `// This sequence drove ${pages.references.length} browsers (${pages.references.join(', ')}).`,
    `// Each gets its own page below - do NOT merge them, the recording exists to`,
    `// test what crosses between them.`,
  ];
  if (pages.mixed) {
    out.push(`// WARNING: some steps named no connection and are emitted against '${'page'}';`);
    out.push(`// check them by hand - which browser they belonged to was not recorded.`);
  }
  return out;
}

/** Puppeteer test code for a sequence's commands. */
export function generatePuppeteerCode(commands: Array<{ tool: string; params: Record<string, any> }>, startUrl?: string): string {
  const pages = buildPageVars(commands);
  const lines: string[] = [
    '// Generated from devharness interaction recording',
    ...generatedCodeHeader(pages),
    'const puppeteer = require(\'puppeteer\');',
    '',
    'async function runTest() {',
    '  const browser = await puppeteer.launch({ headless: false });',
    '  const page = await browser.newPage();',
    ...pages.extras.map(e => `  const ${e.name} = await browser.newPage();  // ${e.ref}`),
    '',
  ];

  if (startUrl) {
    lines.push(`  await page.goto(${jsString(startUrl)});`);
    lines.push('');
  }

  let generatedSteps = 0;

  for (const cmd of commands) {
    // Everything this command emits is rewritten onto its own page below.
    const emittedFrom = lines.length;
    if (cmd.tool === 'navigate') {
      const { action, ...params } = cmd.params;
      if (action === 'goto' && params.url) {
        lines.push(`  await page.goto(${jsString(params.url)});`);
        lines.push('');
      } else if (action === 'reload') {
        lines.push(`  await page.reload();`);
        lines.push('');
      }
    } else if (cmd.tool === 'input') {
      const { action, ...params } = cmd.params;

      switch (action) {
        case 'drag':
          lines.push(`  // Drag from (${params.from.x}, ${params.from.y}) to (${params.to.x}, ${params.to.y})`);
          lines.push(`  await page.mouse.move(${params.from.x}, ${params.from.y});`);
          lines.push(`  await page.mouse.down();`);
          lines.push(`  await page.mouse.move(${params.to.x}, ${params.to.y});`);
          lines.push(`  await page.mouse.up();`);
          lines.push('');
          break;

        case 'scroll':
          lines.push(`  // Scroll at (${params.x}, ${params.y})`);
          if (params.x !== undefined && params.y !== undefined) {
            lines.push(`  await page.mouse.move(${params.x}, ${params.y});`);
          }
          lines.push(`  await page.mouse.wheel({ deltaX: ${params.deltaX || 0}, deltaY: ${params.deltaY || 0} });`);
          lines.push('');
          break;

        case 'mousemove':
          lines.push(`  await page.mouse.move(${params.x}, ${params.y});`);
          break;

        case 'click':
          if (typeof params.x === 'number' && typeof params.y === 'number') {
            lines.push(`  await page.mouse.click(${params.x}, ${params.y});`);
          } else if (params.selector) {
            lines.push(`  await page.click(${jsString(params.selector)});`);
          }
          lines.push('');
          break;

        case 'type':
          lines.push(`  await page.keyboard.type(${jsString(params.text)});`);
          lines.push('');
          break;

        case 'press':
          lines.push(`  await page.keyboard.press(${jsString(params.key)});`);
          lines.push('');
          break;
      }
    }

    // Same rule as the Playwright generator: a dropped step leaves a hole.
    if (lines.length === emittedFrom) {
      lines.push(`  // [not generated] ${describeUngeneratedStep(cmd)}`);
    } else {
      generatedSteps++;
    }

    rewritePage(lines, emittedFrom, pages.varFor(cmd));
  }

  lines.push(...ungeneratedTestGuard(generatedSteps, commands.length, Boolean(startUrl)));
  lines.push('  await browser.close();');
  lines.push('}');
  lines.push('');
  lines.push('runTest().catch(console.error);');

  return lines.join('\n');
}

export function generatePlaywrightCode(commands: Array<{ tool: string; params: Record<string, any>; delay?: number; comment?: string }>, startUrl?: string): string {
  const pages = buildPageVars(commands);
  const lines: string[] = [
    '// Generated from devharness interaction recording',
    ...generatedCodeHeader(pages),
    "import { test, expect } from '@playwright/test';",
    '',
    // A second browser needs its own context, so the multi-connection form takes
    // the `browser` fixture instead of `page` and opens the pages itself.
    pages.multi
      ? "test('recorded interaction', async ({ browser }) => {"
      : "test('recorded interaction', async ({ page }) => {",
    ...(pages.multi ? ['  const page = await (await browser.newContext()).newPage();'] : []),
    ...pages.extras.map(e => `  const ${e.name} = await (await browser.newContext()).newPage();  // ${e.ref}`),
  ];

  if (startUrl) {
    lines.push(`  await page.goto(${jsString(startUrl)});`);
    lines.push('');
  }

  let generatedSteps = 0;

  for (const cmd of commands) {
    const emittedFrom = lines.length;
    // Add comment if present
    if (cmd.comment) {
      lines.push(`  // ${String(cmd.comment).replace(/\s*[\r\n]+\s*/g, ' ')}`);
    }

    // Add delay if present
    if (cmd.delay && cmd.delay > 100) {
      lines.push(`  await page.waitForTimeout(${cmd.delay});`);
    }

    const bodyFrom = lines.length;

    if (cmd.tool === 'navigate') {
      const { action, ...params } = cmd.params;
      if (action === 'goto' && params.url) {
        lines.push(`  await page.goto(${jsString(params.url)});`);
        lines.push('');
      } else if (action === 'reload') {
        lines.push(`  await page.reload();`);
        lines.push('');
      } else if (action === 'back') {
        lines.push(`  await page.goBack();`);
        lines.push('');
      } else if (action === 'forward') {
        lines.push(`  await page.goForward();`);
        lines.push('');
      }
    } else if (cmd.tool === 'input') {
      const { action, ...params } = cmd.params;

      switch (action) {
        case 'drag':
          lines.push(`  // Drag from (${params.from.x}, ${params.from.y}) to (${params.to.x}, ${params.to.y})`);
          lines.push(`  await page.mouse.move(${params.from.x}, ${params.from.y});`);
          lines.push(`  await page.mouse.down();`);
          lines.push(`  await page.mouse.move(${params.to.x}, ${params.to.y});`);
          lines.push(`  await page.mouse.up();`);
          lines.push('');
          break;

        case 'scroll':
          lines.push(`  // Scroll at (${params.x || 0}, ${params.y || 0})`);
          if (params.x !== undefined && params.y !== undefined) {
            lines.push(`  await page.mouse.move(${params.x}, ${params.y});`);
          }
          lines.push(`  await page.mouse.wheel(${params.deltaX || 0}, ${params.deltaY || 0});`);
          lines.push('');
          break;

        case 'mousemove':
          lines.push(`  await page.mouse.move(${params.x}, ${params.y});`);
          break;

        case 'click':
          if (typeof params.x === 'number' && typeof params.y === 'number') {
            lines.push(`  await page.mouse.click(${params.x}, ${params.y});`);
          } else if (params.selector) {
            lines.push(`  await page.click(${jsString(params.selector)});`);
          }
          lines.push('');
          break;

        case 'type':
          // Playwright uses type() for key-by-key typing, fill() for setting value directly
          lines.push(`  await page.keyboard.type(${jsString(params.text)});`);
          lines.push('');
          break;

        case 'press':
          lines.push(`  await page.keyboard.press(${jsString(params.key)});`);
          lines.push('');
          break;

        case 'hover':
          if (params.selector) {
            lines.push(`  await page.hover(${jsString(params.selector)});`);
          }
          lines.push('');
          break;
      }
    }

    // A step with no Playwright equivalent (check, connection, inspect,
    // storage, wait, breakpoint...) must leave a visible hole. Dropping it
    // silently is how a sequence turns into a test that passes without doing
    // anything it was recorded to do.
    if (lines.length === bodyFrom) {
      lines.push(`  // [not generated] ${describeUngeneratedStep(cmd)}`);
    } else {
      generatedSteps++;
    }

    rewritePage(lines, emittedFrom, pages.varFor(cmd));
  }

  lines.push(...ungeneratedTestGuard(generatedSteps, commands.length, Boolean(startUrl)));
  lines.push('});');

  return lines.join('\n');
}

/** Names a step the generators have no equivalent for, for the emitted comment. */
function describeUngeneratedStep(cmd: { tool: string; params: Record<string, any> }): string {
  const action = typeof cmd.params?.action === 'string' ? `({ action: '${cmd.params.action}' })` : '';
  const runs = [cmd.params?.holds, cmd.params?.fails].find(answer => typeof answer?.run === 'string')?.run;
  const extra = cmd.tool === 'check' && runs ? ` — runs the sequence "${runs}"` : '';
  return `${cmd.tool}${action}${extra}`;
}

/**
 * Body for a generated test that ended up with nothing to run. Returning an
 * empty test would export a permanently GREEN file - the failure mode this
 * whole tool exists to avoid - so the generated test fails and says why.
 */
function ungeneratedTestGuard(generatedSteps: number, totalSteps: number, hasStartUrl: boolean): string[] {
  if (generatedSteps > 0 || hasStartUrl) return [];
  return [
    '',
    `  throw new Error('devharness: none of the ${totalSteps} recorded step(s) have a generated equivalent`
      + ` (see the "[not generated]" comments above) - this exported test would otherwise pass without doing anything.`
      + ` Run it with replay({ action: "run" }) instead.');`,
  ];
}
