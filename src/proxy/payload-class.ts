/**
 * What a body is, and what of it a comparison can use.
 *
 * Decoded as text whatever it held, an image or a video segment was kept as
 * mangled characters and compared whole, and a script or a page differed on
 * every build. Each body falls in one class, read from its content type and,
 * where the type is missing or generic, from its first bytes:
 *
 * - `structured`: JSON, form fields, GraphQL. Kept as JSON text and compared
 *   field by field, since a field's value is what a request means.
 * - `document`: HTML, scripts, styles, XML, plain text. Compared on arriving
 *   and its status; its content changes with every build.
 * - `binary`: images, media, fonts, wasm, protobuf, anything undecodable.
 *   Compared on a size band; never decoded.
 */
export type PayloadClass = 'structured' | 'document' | 'binary';

const STRUCTURED_TYPE = /^(application\/(json|[\w.+-]+\+json|x-www-form-urlencoded|graphql|x-ndjson)|text\/json)$/i;
const DOCUMENT_TYPE = /^(text\/|application\/(javascript|ecmascript|x-javascript|xml)$|[\w-]+\/[\w.+-]+\+xml$)/i;
const GENERIC_TYPE = /^(application\/octet-stream|binary\/octet-stream)?$/i;

/** A body's class from its content type, then from its first bytes where the type says nothing. */
export function classOf(contentType: string | undefined, head: Buffer): PayloadClass {
  const type = (contentType ?? '').split(';')[0].trim();
  if (/^multipart\/form-data$/i.test(type)) return 'structured';
  if (STRUCTURED_TYPE.test(type)) return 'structured';
  if (DOCUMENT_TYPE.test(type)) return 'document';
  if (!GENERIC_TYPE.test(type)) return 'binary';
  return sniff(head);
}

function sniff(head: Buffer): PayloadClass {
  if (head.length === 0) return 'document';
  if (head.includes(0)) return 'binary';
  const text = head.toString('utf8');
  // A byte sequence utf8 cannot read becomes U+FFFD.
  if (text.includes('�')) return 'binary';
  const start = text.trimStart()[0];
  if (start === '{' || start === '[') {
    try { JSON.parse(text); return 'structured'; } catch { /* a document that opens with a brace */ }
  }
  return 'document';
}

/**
 * A structured body as JSON text, its fields comparable one by one: JSON as
 * sent, form fields as an object, a multipart form's text fields with each
 * file part reduced to its name and size. Undefined where it does not parse.
 */
export function structuredText(contentType: string | undefined, body: Buffer): string | undefined {
  const type = (contentType ?? '').split(';')[0].trim().toLowerCase();
  if (type === 'application/x-www-form-urlencoded') {
    return JSON.stringify(Object.fromEntries(new URLSearchParams(body.toString('utf8'))));
  }
  if (type === 'multipart/form-data') {
    const boundary = /boundary="?([^";]+)"?/i.exec(contentType ?? '')?.[1];
    return boundary ? JSON.stringify(multipartFields(body, boundary)) : undefined;
  }
  const text = body.toString('utf8');
  try { JSON.parse(text); return text; } catch { return undefined; }
}

function multipartFields(body: Buffer, boundary: string): Record<string, string> {
  const fields: Record<string, string> = {};
  const parts = body.toString('latin1').split(`--${boundary}`);
  for (const part of parts) {
    const split = part.indexOf('\r\n\r\n');
    if (split < 0) continue;
    const headers = part.slice(0, split);
    const name = /name="([^"]*)"/i.exec(headers)?.[1];
    if (name === undefined) continue;
    const content = part.slice(split + 4).replace(/\r\n$/, '');
    const file = /filename="([^"]*)"/i.exec(headers)?.[1];
    fields[name] = file !== undefined
      ? `file ${file} ${Buffer.byteLength(content, 'latin1')} bytes`
      : Buffer.from(content, 'latin1').toString('utf8');
  }
  return fields;
}
