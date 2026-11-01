import { describe, it, expect } from 'vitest';
import { logpointLine } from './write-watch.js';

describe('a console call read as a logpoint row', () => {
  it('drops the query a dev server adds on rebuild from the key', () => {
    expect(logpointLine([{ value: '[Logpoint] http://localhost:5173/src/NoteText.tsx?t=1791166684888:89:auto:' }, { value: 'press' }, { value: '{"path":null}' }]))
      .toEqual({ key: '/src/NoteText.tsx:89', value: '{"path":null}' });
  });

  it('takes the message as the value where the line carries no values', () => {
    expect(logpointLine([{ value: '[Logpoint] http://localhost:3101/client.js:180:auto:' }, { value: 'calc pressed' }]))
      .toEqual({ key: '/client.js:180', value: 'calc pressed' });
  });

  it('reads any other console call as no row', () => {
    expect(logpointLine([{ value: 'Fetching pricing configuration from server...' }])).toBeUndefined();
    expect(logpointLine([{ value: { type: 'object' } }])).toBeUndefined();
  });
});
