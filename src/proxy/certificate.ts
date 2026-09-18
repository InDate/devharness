/**
 * A self-signed certificate for the intercepting proxy, minted here.
 *
 * Node generates keys and signs, and exports a public key as a DER
 * SubjectPublicKeyInfo - which is the certificate field that would otherwise
 * be the work. What is left is DER, which is tag-length-value, so the encoder
 * below is six helpers rather than a dependency.
 *
 * The certificate never has to be trusted. Chrome is launched with
 * --ignore-certificate-errors-spki-list carrying the fingerprint returned
 * here, which makes it accept this key for every host, name mismatch included.
 * Only browsers devharness launches are affected.
 */
import { generateKeyPairSync, createSign, createHash } from 'crypto';

const len = (n: number): Buffer => {
  if (n < 0x80) return Buffer.from([n]);
  const bytes: number[] = [];
  for (let v = n; v > 0; v >>= 8) bytes.unshift(v & 0xff);
  return Buffer.from([0x80 | bytes.length, ...bytes]);
};

const tlv = (tag: number, body: Buffer): Buffer =>
  Buffer.concat([Buffer.from([tag]), len(body.length), body]);

const seq = (...parts: Buffer[]) => tlv(0x30, Buffer.concat(parts));
const set = (...parts: Buffer[]) => tlv(0x31, Buffer.concat(parts));
const int = (buf: Buffer) => tlv(0x02, buf[0] & 0x80 ? Buffer.concat([Buffer.from([0]), buf]) : buf);
const bitString = (buf: Buffer) => tlv(0x03, Buffer.concat([Buffer.from([0]), buf]));
const bool = (v: boolean) => tlv(0x01, Buffer.from([v ? 0xff : 0x00]));
const explicit = (n: number, body: Buffer) => tlv(0xa0 + n, body);
const NULL = Buffer.from([0x05, 0x00]);

/** First two arcs pack into one byte; the rest are base-128 with a carry bit. */
const oid = (dotted: string): Buffer => {
  const arcs = dotted.split('.').map(Number);
  const out = [arcs[0] * 40 + arcs[1]];
  for (const arc of arcs.slice(2)) {
    const chunk = [arc & 0x7f];
    for (let v = arc >> 7; v > 0; v >>= 7) chunk.unshift((v & 0x7f) | 0x80);
    out.push(...chunk);
  }
  return tlv(0x06, Buffer.from(out));
};

const utcTime = (date: Date) => tlv(0x17, Buffer.from(
  date.toISOString().replace(/[-:T]/g, '').slice(2, 14) + 'Z', 'ascii'));

const OID_SHA256_RSA = '1.2.840.113549.1.1.11';
const OID_COMMON_NAME = '2.5.4.3';
const OID_BASIC_CONSTRAINTS = '2.5.29.19';
const OID_SUBJECT_ALT_NAME = '2.5.29.17';

const distinguishedName = (cn: string) =>
  seq(set(seq(oid(OID_COMMON_NAME), tlv(0x0c, Buffer.from(cn, 'utf8')))));

const ALGORITHM = seq(oid(OID_SHA256_RSA), NULL);

/** dNSName is context tag 2 inside GeneralNames. */
const subjectAltName = (hosts: string[]) =>
  tlv(0x04, seq(...hosts.map(h => tlv(0x82, Buffer.from(h, 'ascii')))));

export interface ProxyCertificate {
  cert: string;
  key: string;
  /** Base64 SHA-256 of the SubjectPublicKeyInfo, for Chrome's SPKI list. */
  spkiFingerprint: string;
}

export function mintProxyCertificate(options: {
  commonName?: string;
  hosts?: string[];
  years?: number;
} = {}): ProxyCertificate {
  const { commonName = 'devharness-proxy', hosts = ['localhost'], years = 10 } = options;
  const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const spki = publicKey.export({ type: 'spki', format: 'der' }) as Buffer;

  const from = new Date();
  const until = new Date(from.getTime());
  until.setFullYear(until.getFullYear() + years);

  const tbs = seq(
    explicit(0, int(Buffer.from([0x02]))),
    int(Buffer.from([0x01])),
    ALGORITHM,
    distinguishedName(commonName),
    seq(utcTime(from), utcTime(until)),
    distinguishedName(commonName),
    spki,
    explicit(3, seq(
      seq(oid(OID_BASIC_CONSTRAINTS), bool(true), tlv(0x04, seq(bool(true)))),
      seq(oid(OID_SUBJECT_ALT_NAME), subjectAltName(hosts)),
    )),
  );

  const signature = createSign('sha256').update(tbs).sign(privateKey);
  const der = seq(tbs, ALGORITHM, bitString(signature));

  const pem = (label: string, body: Buffer) =>
    `-----BEGIN ${label}-----\n${body.toString('base64').match(/.{1,64}/g)!.join('\n')}\n-----END ${label}-----\n`;

  return {
    cert: pem('CERTIFICATE', der),
    key: privateKey.export({ type: 'pkcs8', format: 'pem' }) as string,
    spkiFingerprint: createHash('sha256').update(spki).digest('base64'),
  };
}
