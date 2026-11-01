import { describe, it, expect } from 'vitest';
import { NdjsonReader, classifyLine, serializeMessage } from './ndjson-reader.js';

describe('NdjsonReader', () => {
  it('parses a single complete line', () => {
    const reader = new NdjsonReader();
    reader.push(Buffer.from('{"a":1}\n'));
    expect(reader.readLine()).toBe('{"a":1}');
    expect(reader.readLine()).toBeUndefined();
  });

  it('handles a message split across two chunks', () => {
    const reader = new NdjsonReader();
    const full = '{"jsonrpc":"2.0","id":1,"method":"tools/call"}\n';
    const splitAt = 10;
    reader.push(Buffer.from(full.slice(0, splitAt)));
    expect(reader.readLine()).toBeUndefined();
    reader.push(Buffer.from(full.slice(splitAt)));
    expect(reader.readLine()).toBe(full.trim());
  });

  it('handles multiple messages in one chunk', () => {
    const reader = new NdjsonReader();
    reader.push(Buffer.from('{"a":1}\n{"a":2}\n{"a":3}\n'));
    expect(reader.readAllLines()).toEqual(['{"a":1}', '{"a":2}', '{"a":3}']);
  });

  it('handles a multi-byte UTF-8 character split exactly at a chunk boundary', () => {
    const reader = new NdjsonReader();
    // U+1F600 (😀) is 4 bytes in UTF-8: F0 9F 98 80
    const line = '{"msg":"hi 😀"}\n';
    const bytes = Buffer.from(line, 'utf8');
    const emojiStart = bytes.indexOf(0xf0); // start of the 4-byte sequence
    reader.push(bytes.subarray(0, emojiStart + 2)); // split mid-emoji
    expect(reader.readLine()).toBeUndefined();
    reader.push(bytes.subarray(emojiStart + 2));
    expect(reader.readLine()).toBe('{"msg":"hi 😀"}');
  });

  it('strips a trailing \\r (CRLF line endings)', () => {
    const reader = new NdjsonReader();
    reader.push(Buffer.from('{"a":1}\r\n'));
    expect(reader.readLine()).toBe('{"a":1}');
  });

  it('a malformed line does not corrupt subsequent valid lines', () => {
    const reader = new NdjsonReader();
    reader.push(Buffer.from('not json at all\n{"jsonrpc":"2.0","id":1,"result":{}}\n'));
    const lines = reader.readAllLines();
    expect(lines).toEqual(['not json at all', '{"jsonrpc":"2.0","id":1,"result":{}}']);
    expect(classifyLine(lines[0]).kind).toBe('unparseable');
    expect(classifyLine(lines[1]).kind).toBe('response');
  });
});

describe('classifyLine', () => {
  it('classifies a request (has id and method)', () => {
    const parsed = classifyLine('{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}');
    expect(parsed).toMatchObject({ kind: 'request', id: 1, method: 'initialize' });
  });

  it('classifies a notification (has method, no id)', () => {
    const parsed = classifyLine('{"jsonrpc":"2.0","method":"notifications/initialized"}');
    expect(parsed).toMatchObject({ kind: 'notification', method: 'notifications/initialized' });
  });

  it('classifies a response (has id, no method)', () => {
    const parsed = classifyLine('{"jsonrpc":"2.0","id":1,"result":{}}');
    expect(parsed).toMatchObject({ kind: 'response', id: 1 });
  });

  it('classifies an error response (has id, no method) the same as a response', () => {
    const parsed = classifyLine('{"jsonrpc":"2.0","id":1,"error":{"code":-32000,"message":"boom"}}');
    expect(parsed).toMatchObject({ kind: 'response', id: 1 });
  });

  it('classifies invalid JSON as unparseable without throwing', () => {
    expect(() => classifyLine('{not valid')).not.toThrow();
    expect(classifyLine('{not valid').kind).toBe('unparseable');
  });

  it('classifies a JSON value with neither id nor method as unparseable', () => {
    expect(classifyLine('{"jsonrpc":"2.0"}').kind).toBe('unparseable');
    expect(classifyLine('null').kind).toBe('unparseable');
    expect(classifyLine('42').kind).toBe('unparseable');
  });

  it('preserves a string id', () => {
    const parsed = classifyLine('{"jsonrpc":"2.0","id":"abc-123","result":{}}');
    expect(parsed).toMatchObject({ kind: 'response', id: 'abc-123' });
  });
});

describe('serializeMessage', () => {
  it('serializes with a trailing newline', () => {
    expect(serializeMessage({ a: 1 })).toBe('{"a":1}\n');
  });
});
