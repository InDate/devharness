/**
 * What three replay actions write and return.
 *
 * - `repeat` over several indices returns each step's reply: a repeated
 *   read-back is run for its value, and a reply holding only a tick leaves the
 *   caller running the expression again as a fresh call (#103).
 * - `insert` into a new sequence carries every declaration of the source: a
 *   copy without `requiredConnections` launches none of the browsers the
 *   steps name (#107).
 * - `export` writes under the sequence's own name, so a `filename` holds no
 *   effect and is refused rather than ignored (#108).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { createReplayTools } from './replay-tools.js';
import { CommandRecorder } from '../command-recorder.js';
import { productionShaped } from '../test-support/fake-execute-tool-call.js';
import { setWorkingDirOverride } from '../helpers/paths.js';

// A create, a run and an export write sequence files; a temp project keeps a
// regression from writing them into the repo's own .devharness.
let dir: string;
beforeEach(async () => {
  dir = await fs.mkdtemp(join(tmpdir(), 'cdp-edit-replies-'));
  setWorkingDirOverride(dir);
});
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

const TAB = 'walk-tab';

function harness() {
  const executeToolCall = vi.fn(productionShaped(async (tool: string, params: Record<string, any>) => {
    if (tool === 'connection' && params.action === 'list') {
      return {
        content: [{ type: 'text', text: 'Active debugger connections (1 total)' }],
        _meta: { tool: 'connection', action: 'list', timestamp: 0, connections: [
          { reference: TAB, type: 'chrome', host: 'localhost', port: 9222, active: true, connected: true, paused: false },
        ] },
      };
    }
    if (tool === 'inspect') return { content: [{ type: 'text', text: 'Expression evaluated successfully\n\nResult:\n```\n{width:500;height:700}\n```' }] };
    if (tool === 'input') return { content: [{ type: 'text', text: '**Dragged from (100, 50) on button #target "Remove" to (300, 400) on no element**\n**Distance:** 403.1px' }] };
    return { content: [{ type: 'text', text: '' }] };
  }));
  const recorder = new CommandRecorder();
  const { replay } = createReplayTools(recorder, executeToolCall as any, async () => null, async () => null, undefined);
  return { replay, recorder };
}

const text = (res: any) => res.content.map((part: any) => part.text).join('\n') as string;

describe('repeat over several indices', () => {
  it('prints a read-back step\'s reading under its line', async () => {
    const { replay, recorder } = harness();
    await recorder.recordCommand('inspect', { action: 'evaluateExpression', expression: '({ width: innerWidth, height: innerHeight })', connection: TAB });
    await recorder.recordCommand('input', { action: 'drag', from: { x: 100, y: 50 }, to: { x: 300, y: 400 }, connection: TAB });

    const reply = text(await replay.handler({ action: 'repeat', indices: [0, 1] } as any));

    expect(reply).toContain('#0. **inspect** ✓\n    Expression evaluated successfully');
    expect(reply).toContain('    {width:500;height:700}');
  });

  it('prints an action step\'s first reply line beside its tick', async () => {
    const { replay, recorder } = harness();
    await recorder.recordCommand('inspect', { action: 'evaluateExpression', expression: '1', connection: TAB });
    await recorder.recordCommand('input', { action: 'drag', from: { x: 100, y: 50 }, to: { x: 300, y: 400 }, connection: TAB });

    const reply = text(await replay.handler({ action: 'repeat', indices: [0, 1] } as any));

    expect(reply).toContain('#1. **input** ✓ - Dragged from (100, 50) on button #target "Remove" to (300, 400) on no element');
    expect(reply).not.toContain('Distance');
  });
});

describe('insert into a new sequence', () => {
  async function pausedWith(declarations: Record<string, unknown>) {
    const { replay, recorder } = harness();
    await recorder.recordCommand('dom', { action: 'querySelector', selector: '#a', connection: TAB });
    await recorder.recordCommand('dom', { action: 'querySelector', selector: '#b', connection: TAB });
    await replay.handler({ action: 'create', name: 'walk', indices: [0, 1] } as any);
    Object.assign(recorder.listSequences().find(s => s.name === 'walk')!, declarations);
    await replay.handler({ action: 'run', wait: true, name: 'walk', stepTo: 1 } as any);
    await recorder.recordCommand('dom', { action: 'querySelector', selector: '#inserted', connection: TAB });
    const index = recorder.getCurrentHistoryIndex();
    await replay.handler({ action: 'history' } as any);
    return { replay, recorder, index };
  }

  it('carries requiredConnections and tags into the new sequence', async () => {
    const required = [{ connection: 'messaging-host-root', forceNewInstance: true }];
    const { replay, recorder, index } = await pausedWith({ requiredConnections: required, tags: ['messaging'] });

    await replay.handler({ action: 'insert', name: 'walk', insertIndices: [index] } as any);

    const copy = recorder.listSequences().find(s => s.name === 'walk-modified') as any;
    expect(copy.requiredConnections).toEqual(required);
    expect(copy.tags).toEqual(['messaging']);
    expect(copy.commands.map((c: any) => c.params.selector)).toEqual(['#a', '#inserted', '#b']);
  });

  it('moves a step-stamped name past the inserted step, and leaves the source as it was', async () => {
    const { replay, recorder, index } = await pausedWith({ boundaryNames: { '2|← "tag":"small"': 'small tag' } });

    await replay.handler({ action: 'insert', name: 'walk', insertIndices: [index] } as any);

    const copy = recorder.listSequences().find(s => s.name === 'walk-modified') as any;
    const source = recorder.listSequences().find(s => s.name === 'walk') as any;
    expect(copy.boundaryNames).toEqual({ '3|← "tag":"small"': 'small tag' });
    expect(source.boundaryNames).toEqual({ '2|← "tag":"small"': 'small tag' });
  });
});

describe('export with a filename', () => {
  it('refuses the filename and names the routes that write elsewhere', async () => {
    const { replay, recorder } = harness();
    await recorder.recordCommand('dom', { action: 'querySelector', selector: '#a', connection: TAB });
    await replay.handler({ action: 'create', name: 'walk-modified', indices: [0] } as any);

    await expect(replay.handler({ action: 'export', name: 'walk-modified', filename: 'walk', overwrite: true } as any))
      .resolves.toMatchObject({ isError: true });
    const reply = text(await replay.handler({ action: 'export', name: 'walk-modified', filename: 'walk' } as any));
    expect(reply).toContain('`filename` holds no effect');
    expect(reply).toContain('`insert` with `overwrite: true`');
  });
});
