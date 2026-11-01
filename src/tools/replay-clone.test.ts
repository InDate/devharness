/**
 * `replay clone`: a new sequence owning every step of another, standing apart
 * from it afterwards. `copy` cuts a sequence part-way and leaves its teardown;
 * a clone starts as the whole of the original.
 */
import { describe, it, expect, vi } from 'vitest';
import { createReplayTools } from './replay-tools.js';
import { CommandRecorder } from '../command-recorder.js';
import { productionShaped } from '../test-support/fake-execute-tool-call.js';

function harness() {
  const recorder = new CommandRecorder();
  const executeToolCall = vi.fn(productionShaped(async () => ({ content: [{ type: 'text', text: '' }] })));
  const { replay } = createReplayTools(recorder, executeToolCall as any, async () => null, async () => null, undefined);
  return { recorder, replay };
}

async function original(recorder: CommandRecorder) {
  await recorder.createSequenceFromCommands('clone-source', [
    { tool: 'navigate', params: { action: 'goto', url: 'http://localhost:4100/' } },
    { tool: 'input', params: { action: 'click', selector: '#go' } },
  ] as any, { description: 'walks to go', startUrl: 'http://localhost:4100/' });
  const source = recorder.listSequences().find(s => s.name === 'clone-source')!;
  (source.commands[1] as any).pauseBefore = true;
  source.teardown = [{ tool: 'navigate', params: { action: 'goto', url: 'about:blank' } } as any];
  (source as any).tags = ['ui'];
  return source;
}

const named = (recorder: CommandRecorder, name: string) => recorder.listSequences().find(s => s.name === name);

describe('replay clone', () => {
  it('copies every step, its pause points, the teardown and the declarations', async () => {
    const { recorder, replay } = harness();
    const source = await original(recorder);

    await replay.handler({ action: 'clone', name: 'clone-source', newName: 'clone-copy' } as any);

    const clone = named(recorder, 'clone-copy')!;
    expect(clone.commands.map(c => c.params)).toEqual(source.commands.map(c => c.params));
    expect((clone.commands[1] as any).pauseBefore).toBe(true);
    expect(clone.teardown).toEqual(source.teardown);
    expect((clone as any).tags).toEqual(['ui']);
    expect(clone.description).toBe('walks to go');
  });

  it('stands apart: an edit to the clone leaves the original as it was', async () => {
    const { recorder, replay } = harness();
    await original(recorder);
    await replay.handler({ action: 'clone', name: 'clone-source', newName: 'clone-copy' } as any);

    named(recorder, 'clone-copy')!.commands[1].params.selector = '#elsewhere';

    expect(named(recorder, 'clone-source')!.commands[1].params.selector).toBe('#go');
  });

  it('refuses the original name and a name already taken', async () => {
    const { recorder, replay } = harness();
    await original(recorder);
    await recorder.createSequenceFromCommands('taken-name', [{ tool: 'input', params: { action: 'click', selector: '#x' } }] as any);

    const same: any = await replay.handler({ action: 'clone', name: 'clone-source', newName: 'clone-source' } as any);
    const taken: any = await replay.handler({ action: 'clone', name: 'clone-source', newName: 'taken-name' } as any);

    expect(same.isError).toBe(true);
    expect(same.content[0].text).toContain('A clone takes a name of its own');
    expect(taken.isError).toBe(true);
    expect(taken.content[0].text).toContain('A sequence named "taken-name" exists');
  });
});
