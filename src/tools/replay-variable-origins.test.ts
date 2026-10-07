/**
 * A variable whose value differs by URL: the origin the run starts at picks a
 * secret's `NAME@<origin>` line and a property's `byOrigin` entry, and every
 * other origin gets the plain value.
 */
import { describe, it, expect, vi } from 'vitest';
import { envNames, envValueFor, parseEnvFile, withEnvEntries } from '../helpers/env-file.js';
import { interpolateParams } from './interpolation.js';
import { executeSteps } from './replay-executor.js';
import { productionShaped } from '../test-support/fake-execute-tool-call.js';

describe('per-origin values in the env file', () => {
  it('reads NAME@<origin> beside the plain NAME, and a run picks by its origin', () => {
    const { values, problems } = parseEnvFile('TOKEN=everywhere\nTOKEN@https://staging.example.com=on-staging\n');
    expect(problems).toEqual([]);
    expect(envValueFor(values, 'TOKEN', 'https://staging.example.com')).toBe('on-staging');
    expect(envValueFor(values, 'TOKEN', 'http://localhost:7788')).toBe('everywhere');
    expect(envNames(values).get('TOKEN')).toEqual({ plain: true, origins: ['https://staging.example.com'] });
  });

  it('replaces every line for a name and keeps the rest of the file', () => {
    const before = '# project secrets\nOTHER=1\nTOKEN=old\nTOKEN@https://a.example=old-a\n';
    const after = withEnvEntries(before, 'TOKEN', { value: 'new value', byOrigin: { 'https://b.example': 'b' } });
    expect(after).toBe('# project secrets\nOTHER=1\nTOKEN=new value\nTOKEN@https://b.example=b\n');
    expect(withEnvEntries(after, 'TOKEN', null)).toBe('# project secrets\nOTHER=1\n');
  });

  it('quotes a value the parser would otherwise read differently', () => {
    const text = withEnvEntries('', 'PASS', { value: ' padded #x' });
    expect(parseEnvFile(text).values.PASS).toBe(' padded #x');
  });

  it('resolves {{env:NAME}} to the run origin\'s value', () => {
    const runEnv = { TOKEN: 'everywhere', 'TOKEN@https://staging.example.com': 'on-staging' };
    const typed = interpolateParams({ text: '{{env:TOKEN}}' }, {}, 0, runEnv, 'sequences.env', 'https://staging.example.com');
    expect(typed.text).toBe('on-staging');
  });
});

describe('a stored property that differs by URL', () => {
  it('stores the run origin\'s value, and the plain one elsewhere', async () => {
    const stored = async (runOrigin: string) => {
      const store: Record<string, any> = {};
      const executeToolCall = vi.fn(productionShaped(async (_tool: string, params: Record<string, any>) => {
        const value = typeof params.expression === 'string' ? JSON.parse(params.expression) : undefined;
        return { content: [{ type: 'text', text: '' }], _meta: { inspect: { value } } };
      }));
      await executeSteps({
        sequence: { id: 's', name: 'per-url', createdAt: 1, commands: [{
          tool: 'inspect',
          params: { action: 'evaluateExpression', expression: JSON.stringify('local-user'), saveAs: 'user' },
          byOrigin: { 'https://staging.example.com': 'staging-user' },
        }] },
        startStep: 0,
        ctx: { executeToolCall, connection: 'app', variableStore: store, runOrigin } as any,
      });
      return executeToolCall.mock.calls.find(([tool, params]) => tool === 'inspect' && params.saveAs === 'user')?.[1].expression;
    };
    expect(await stored('https://staging.example.com')).toBe(JSON.stringify('staging-user'));
    expect(await stored('http://localhost:7788')).toBe(JSON.stringify('local-user'));
  });
});
