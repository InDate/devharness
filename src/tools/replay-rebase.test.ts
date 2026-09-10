import { describe, it, expect } from 'vitest';
import { rebaseSequence } from './replay-executor.js';
import type { CommandSequence } from '../command-recorder.js';

const seq = (overrides: Partial<CommandSequence> = {}): CommandSequence => ({
  id: 'seq-test',
  name: 'test-seq',
  startUrl: 'http://localhost:5174/?r=sh-1',
  commands: [
    { tool: 'navigate', params: { action: 'goto', url: 'http://localhost:5174/api/dev/enrol-link?prompt=employees-full' } },
    { tool: 'request', params: { action: 'fetch', url: '/api/consumable', method: 'POST', body: { kind: 'draw' } } },
    { tool: 'input', params: { action: 'click', selector: 'button:has-text("Alice")' } },
    { tool: 'assert', params: { action: 'exists', urls: ['https://localhost:5174/a', 'not a url'] } },
  ],
  createdAt: 1,
  ...overrides,
});

describe('rebaseSequence', () => {
  it('rewrites the origin of startUrl and absolute command URLs, keeping path/query', () => {
    const out = rebaseSequence(seq(), { baseUrl: 'https://cue-test.pages.dev' });
    expect(out.startUrl).toBe('https://cue-test.pages.dev/?r=sh-1');
    expect(out.commands[0].params.url).toBe('https://cue-test.pages.dev/api/dev/enrol-link?prompt=employees-full');
  });

  it('leaves relative URLs and non-URL strings untouched', () => {
    const out = rebaseSequence(seq(), { baseUrl: 'https://cue-test.pages.dev' });
    expect(out.commands[1].params.url).toBe('/api/consumable');
    expect(out.commands[2].params.selector).toBe('button:has-text("Alice")');
    expect(out.commands[3].params.urls[1]).toBe('not a url');
  });

  it('rebases strings nested in arrays and objects', () => {
    const out = rebaseSequence(seq(), { baseUrl: 'https://cue-test.pages.dev' });
    expect(out.commands[3].params.urls[0]).toBe('https://cue-test.pages.dev/a');
    expect(out.commands[1].params.body).toEqual({ kind: 'draw' });
  });

  it('startUrl override replaces the entry URL wholesale', () => {
    const out = rebaseSequence(seq(), {
      baseUrl: 'https://cue-test.pages.dev',
      startUrl: 'https://cue-test.pages.dev/?r=minted-xyz',
    });
    expect(out.startUrl).toBe('https://cue-test.pages.dev/?r=minted-xyz');
    // commands still rebased
    expect(out.commands[0].params.url).toBe('https://cue-test.pages.dev/api/dev/enrol-link?prompt=employees-full');
  });

  it('startUrl override works without a baseUrl', () => {
    const out = rebaseSequence(seq(), { startUrl: 'https://other.example/?r=x' });
    expect(out.startUrl).toBe('https://other.example/?r=x');
    expect(out.commands[0].params.url).toBe('http://localhost:5174/api/dev/enrol-link?prompt=employees-full');
  });

  it('does not mutate the source sequence', () => {
    const original = seq();
    const before = JSON.parse(JSON.stringify(original));
    rebaseSequence(original, { baseUrl: 'https://cue-test.pages.dev' });
    expect(original).toEqual(before);
  });

  it('handles a sequence without a startUrl', () => {
    const out = rebaseSequence(seq({ startUrl: undefined }), { baseUrl: 'https://cue-test.pages.dev' });
    expect(out.startUrl).toBeUndefined();
  });
});

describe('rebaseSequence: declared connections', () => {
  const declared = (): CommandSequence => seq({
    requiredConnections: [
      { reference: 'member-one', url: 'http://localhost:5174/join?code=7' },
      { reference: 'member-two' },
    ],
  });

  it("rewrites a declared connection's launch url", () => {
    const out = rebaseSequence(declared(), { baseUrl: 'https://cue-test.pages.dev' });
    expect(out.requiredConnections![0].url).toBe('https://cue-test.pages.dev/join?code=7');
  });

  it('leaves a declaration without a url alone', () => {
    const out = rebaseSequence(declared(), { baseUrl: 'https://cue-test.pages.dev' });
    expect(out.requiredConnections![1]).toEqual({ reference: 'member-two' });
  });

  it('does not mutate the stored declaration', () => {
    const original = declared();
    rebaseSequence(original, { baseUrl: 'https://cue-test.pages.dev' });
    expect(original.requiredConnections![0].url).toBe('http://localhost:5174/join?code=7');
  });

  it('carries the declarations through when no baseUrl is given', () => {
    const out = rebaseSequence(declared(), { startUrl: 'http://localhost:5174/other' });
    expect(out.requiredConnections![0].url).toBe('http://localhost:5174/join?code=7');
  });
});
