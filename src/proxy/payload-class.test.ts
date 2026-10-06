/**
 * What class a body falls in, which decides what of it a comparison reads.
 */
import { describe, it, expect } from 'vitest';
import { classOf, structuredText } from './payload-class.js';

const bytes = (text: string) => Buffer.from(text);

describe('a body by its content type', () => {
  it('reads JSON, form fields and multipart forms as structured', () => {
    expect(classOf('application/json; charset=utf-8', bytes('{}'))).toBe('structured');
    expect(classOf('application/vnd.api+json', bytes('{}'))).toBe('structured');
    expect(classOf('application/x-www-form-urlencoded', bytes('a=1'))).toBe('structured');
    expect(classOf('multipart/form-data; boundary=x', bytes(''))).toBe('structured');
  });

  it('reads pages, scripts, styles and text as documents', () => {
    for (const type of ['text/html', 'application/javascript', 'text/css', 'application/xml', 'image/svg+xml', 'text/plain']) {
      expect(classOf(type, bytes('<p>'))).toBe('document');
    }
  });

  it('reads images, media, fonts and wasm as binary', () => {
    for (const type of ['image/png', 'video/mp4', 'audio/mpeg', 'font/woff2', 'application/wasm', 'application/x-protobuf']) {
      expect(classOf(type, bytes('x'))).toBe('binary');
    }
  });
});

describe('a body with no type, or a generic one', () => {
  it('reads its first bytes', () => {
    expect(classOf(undefined, bytes('{"a":1}'))).toBe('structured');
    expect(classOf('application/octet-stream', Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00]))).toBe('binary');
    expect(classOf(undefined, Buffer.from([0xff, 0xfe, 0xfd]))).toBe('binary');
    expect(classOf(undefined, bytes('{ not json'))).toBe('document');
  });
});

describe('a structured body as JSON text', () => {
  it('keeps JSON as sent and turns form fields into an object', () => {
    expect(structuredText('application/json', bytes('{"dark":true}'))).toBe('{"dark":true}');
    expect(JSON.parse(structuredText('application/x-www-form-urlencoded', bytes('dark=1&name=a%20b'))!)).toEqual({ dark: '1', name: 'a b' });
  });

  it("keeps a multipart form's text fields and reduces each file to its name and size", () => {
    const body = bytes([
      '--b', 'Content-Disposition: form-data; name="title"', '', 'Holiday', '--b',
      'Content-Disposition: form-data; name="photo"; filename="beach.png"', 'Content-Type: image/png', '', 'PNGDATA', '--b--', '',
    ].join('\r\n'));
    expect(JSON.parse(structuredText('multipart/form-data; boundary=b', body)!)).toEqual({ title: 'Holiday', photo: 'file beach.png 7 bytes' });
  });
});
