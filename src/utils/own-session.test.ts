import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'fs';
import { join, relative } from 'path';
import { OWN_SCRIPTS, tagPageSource } from './own-script.js';
import { tagClient, tagSession } from './own-session.js';

const SRC = join(process.cwd(), 'src');

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap(name => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name) ? [path] : [];
  });
}

const sourceURL = (source: string) => /\/\/# sourceURL=(\S+)/.exec(source)?.[1];

describe('page source sent through a session goes out tagged as devharness\'s own', () => {
  it('tags an evaluate expression and a script added for new documents', () => {
    expect(sourceURL(tagPageSource('Runtime.evaluate', { expression: '1 + 1' }).expression)).toMatch(OWN_SCRIPTS);
    expect(sourceURL(tagPageSource('Page.addScriptToEvaluateOnNewDocument', { source: 'void 0' }).source)).toMatch(OWN_SCRIPTS);
  });

  it('ends a function declaration\'s tag with a newline, which Chrome\'s parenthesised wrap of it needs', () => {
    const { functionDeclaration } = tagPageSource('Runtime.callFunctionOn', { functionDeclaration: 'function () { return this; }' });
    expect(sourceURL(functionDeclaration)).toMatch(OWN_SCRIPTS);
    expect(functionDeclaration.endsWith('\n')).toBe(true);
  });

  it('keeps a sourceURL the caller named, and leaves other commands and other params alone', () => {
    const named = { expression: 'x\n//# sourceURL=devharness://clock', returnByValue: true };
    expect(tagPageSource('Runtime.evaluate', named)).toBe(named);
    const other = { animationId: '7' };
    expect(tagPageSource('Animation.resolveAnimation', other)).toBe(other);
    expect(tagPageSource('Runtime.evaluate', { expression: '0', returnByValue: true }).returnByValue).toBe(true);
  });

  it('tags what a session sends through its view, and leaves the session itself as it was', async () => {
    const sent: Array<[string, any]> = [];
    const send = async (method: string, params?: any) => { sent.push([method, params]); };
    const session = { send, label: () => 'own' };
    const view = tagSession(session);
    await view.send('Runtime.evaluate', { expression: 'document.title' });
    expect(sourceURL(sent[0][1].expression)).toMatch(OWN_SCRIPTS);
    expect(session.send).toBe(send);
    expect(view.label()).toBe('own');
  });

  it('tags a client whose domain methods call its own send', async () => {
    const sent: Array<[string, any]> = [];
    const client: any = { send: async (method: string, params?: any) => { sent.push([method, params]); } };
    client.Runtime = { evaluate: (params: any) => client.send('Runtime.evaluate', params) };
    tagClient(client);
    await client.Runtime.evaluate({ expression: 'document.title' });
    expect(sourceURL(sent[0][1].expression)).toMatch(OWN_SCRIPTS);
  });
});

describe('every CDP session devharness opens passes through the one door', () => {
  const files = sourceFiles(SRC);

  it('opens no puppeteer session outside own-session.ts', () => {
    const outside = files
      .filter(file => !file.endsWith(join('utils', 'own-session.ts')))
      .filter(file => /\.createCDPSession\(/.test(readFileSync(file, 'utf8')))
      .map(file => relative(SRC, file));
    expect(outside).toEqual([]);
  });

  it('tags every chrome-remote-interface client it connects: tagClient imported and used', () => {
    const untagged = files
      .filter(file => readFileSync(file, 'utf8').includes("from 'chrome-remote-interface'"))
      .filter(file => (readFileSync(file, 'utf8').match(/\btagClient\b/g) ?? []).length < 2)
      .map(file => relative(SRC, file));
    expect(untagged).toEqual([]);
  });
});
