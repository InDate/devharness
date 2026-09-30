import { describe, it, expect } from 'vitest';
import {
  extractFencedBlocks,
  findSequenceBlock,
  findSequenceBlocks,
  emitSequenceBlock,
  stripSequenceBlocks,
  parseRemoteSequence,
  auditSequence,
} from './issue-body.js';

const SEQ = { name: 'repro', commands: [{ tool: 'navigate', params: { url: 'http://x' } }] };

describe('fence scanning', () => {
  it('round-trips a sequence through emit and find', () => {
    const body = `## Steps\n\n${emitSequenceBlock(SEQ)}\n`;
    const block = findSequenceBlock(body);
    expect(block).not.toBeNull();
    expect(JSON.parse(block!.content)).toEqual(SEQ);
  });

  it('ignores a plain code block that precedes the sequence (the bug-001 shape)', () => {
    const body = [
      '## Steps to reproduce',
      '',
      '```js',
      '// suspect this handler is missing a guard',
      'submitButton.addEventListener("click", handleSubmit);',
      '```',
      '',
      emitSequenceBlock(SEQ),
      '',
    ].join('\n');

    const blocks = extractFencedBlocks(body);
    expect(blocks).toHaveLength(2);
    expect(blocks[0].info).toBe('js');
    expect(JSON.parse(findSequenceBlock(body)!.content)).toEqual(SEQ);
  });

  it('widens the fence when the sequence itself contains backticks', () => {
    const withTemplate = {
      name: 'repro',
      commands: [{ tool: 'execution', params: { expression: 'const s = `a ``` b`; return s;' } }],
    };
    const emitted = emitSequenceBlock(withTemplate);

    // A 3-backtick fence would be closed early by the payload.
    expect(emitted.startsWith('````')).toBe(true);
    expect(JSON.parse(findSequenceBlock(emitted)!.content)).toEqual(withTemplate);
  });

  it('does not let a shorter inner fence close a longer outer one', () => {
    const body = ['````text', 'here is how you write one:', '```json devharness-sequence', '```', '````'].join('\n');
    const blocks = extractFencedBlocks(body);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].info).toBe('text');
    // The inner block is documentation, not a sequence to run.
    expect(findSequenceBlock(body)).toBeNull();
  });

  it('takes the first sequence block, not the last', () => {
    const first = { name: 'first', commands: [{ tool: 'navigate' }] };
    const second = { name: 'second', commands: [{ tool: 'navigate' }] };
    const body = `${emitSequenceBlock(first)}\n\ntext\n\n${emitSequenceBlock(second)}`;

    expect(findSequenceBlocks(body)).toHaveLength(2);
    expect(JSON.parse(findSequenceBlock(body)!.content).name).toBe('first');
  });

  it('only matches the devharness tag, not any json block', () => {
    const body = '```json\n{"commands":[]}\n```';
    expect(findSequenceBlock(body)).toBeNull();
    expect(extractFencedBlocks(body)[0].info).toBe('json');
  });

  it('handles CRLF input', () => {
    const body = `## Steps\r\n\r\n${emitSequenceBlock(SEQ).replace(/\n/g, '\r\n')}\r\n`;
    expect(JSON.parse(findSequenceBlock(body)!.content)).toEqual(SEQ);
  });

  it('treats an unterminated fence as a block rather than dropping it', () => {
    const body = '```json devharness-sequence\n{"commands":[]}';
    expect(findSequenceBlock(body)).not.toBeNull();
  });
});

describe('stripSequenceBlocks', () => {
  it('removes the block and leaves the prose', () => {
    const body = `## Steps\n\nDo the thing.\n\n${emitSequenceBlock(SEQ)}\n`;
    expect(stripSequenceBlocks(body)).toBe('## Steps\n\nDo the thing.');
  });

  it('leaves other code blocks alone', () => {
    const body = ['Prose.', '', '```js', 'code();', '```', '', emitSequenceBlock(SEQ)].join('\n');
    const stripped = stripSequenceBlocks(body);
    expect(stripped).toContain('```js');
    expect(stripped).not.toContain('devharness-sequence');
  });

  it('is stable across strip -> re-emit -> strip', () => {
    const original = '## Steps\n\nDo the thing.';
    const published = `${original}\n\n${emitSequenceBlock(SEQ)}`;
    const once = stripSequenceBlocks(published);
    const twice = stripSequenceBlocks(`${once}\n\n${emitSequenceBlock(SEQ)}`);
    expect(once).toBe(original);
    expect(twice).toBe(original);
  });

  it('returns the input untouched when there is no sequence', () => {
    const body = 'Just prose.\n\n```js\ncode();\n```';
    expect(stripSequenceBlocks(body)).toBe(body);
  });
});

describe('parseRemoteSequence', () => {
  it('accepts a well-formed sequence', () => {
    const result = parseRemoteSequence(JSON.stringify(SEQ));
    expect(result.ok).toBe(true);
  });

  it('drops unknown top-level keys rather than carrying them to disk', () => {
    const result = parseRemoteSequence(JSON.stringify({
      ...SEQ,
      id: 'seq-attacker',
      somethingElse: { nested: true },
    }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.sequence).not.toHaveProperty('id');
    expect(result.sequence).not.toHaveProperty('somethingElse');
  });

  it('rejects a payload over the size limit before parsing it', () => {
    const huge = JSON.stringify({ commands: [{ tool: 'navigate', params: { pad: 'x'.repeat(300_000) } }] });
    const result = parseRemoteSequence(huge);
    expect(result).toMatchObject({ ok: false });
    if (result.ok) return;
    expect(result.reason).toContain('256KB');
  });

  it('rejects malformed JSON, missing commands, a non-string tool, and too many steps', () => {
    expect(parseRemoteSequence('{oops').ok).toBe(false);
    expect(parseRemoteSequence('{"name":"x"}').ok).toBe(false);
    expect(parseRemoteSequence('{"commands":[{"tool":42}]}').ok).toBe(false);
    expect(parseRemoteSequence('{"commands":[]}').ok).toBe(false);
    const tooMany = { commands: Array.from({ length: 501 }, () => ({ tool: 'navigate' })) };
    expect(parseRemoteSequence(JSON.stringify(tooMany)).ok).toBe(false);
  });

  it('names the offending path in the reason', () => {
    const result = parseRemoteSequence('{"commands":[{"tool":""}]}');
    expect(result).toMatchObject({ ok: false });
    if (result.ok) return;
    expect(result.reason).toContain('commands.0.tool');
  });
});

describe('auditSequence', () => {
  it('lists tools and flags the privileged ones', () => {
    const parsed = parseRemoteSequence(JSON.stringify({
      commands: [
        { tool: 'navigate' },
        { tool: 'input' },
        { tool: 'execution', params: { expression: 'fetch("/x")' } },
      ],
      teardown: [{ tool: 'server', params: { action: 'stop' } }],
    }));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;

    const audit = auditSequence(parsed.sequence);
    expect(audit.steps).toBe(4);
    expect(audit.tools).toEqual(['execution', 'input', 'navigate', 'server']);
    expect(audit.privileged).toEqual(['execution', 'server']);
  });

  it('flags a step that kills a browser, under its old name or its new one', () => {
    const parsed = parseRemoteSequence(JSON.stringify({
      commands: [{ tool: 'navigate' }, { tool: 'killChrome', params: { reason: 'r' } }],
      teardown: [{ tool: 'browser', params: { action: 'kill', reason: 'r' } }],
    }));
    if (!parsed.ok) throw new Error('expected ok');
    expect(auditSequence(parsed.sequence).privileged).toEqual(['browser']);
  });

  it('flags a step that replays other calls or changes the server', () => {
    const parsed = parseRemoteSequence(JSON.stringify({
      commands: [
        { tool: 'replay', params: { action: 'runFromLog', lines: [1] } },
        { tool: 'config', params: { action: 'restart' } },
      ],
    }));
    if (!parsed.ok) throw new Error('expected ok');
    expect(auditSequence(parsed.sequence).privileged).toEqual(['config', 'replay']);
  });

  it('reads an old saveToDisk step as download, and flags it', () => {
    const parsed = parseRemoteSequence(JSON.stringify({
      commands: [{ tool: 'saveToDisk', params: { url: 'http://a/f.txt', filename: 'f.txt' } }],
    }));
    if (!parsed.ok) throw new Error('expected ok');
    expect(parsed.sequence.commands[0].tool).toBe('download');
    expect(auditSequence(parsed.sequence).privileged).toEqual(['download']);
  });

  it('reports nothing privileged for a plain UI sequence', () => {
    const parsed = parseRemoteSequence(JSON.stringify(SEQ));
    if (!parsed.ok) throw new Error('expected ok');
    expect(auditSequence(parsed.sequence).privileged).toEqual([]);
  });
});
