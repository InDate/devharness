/**
 * An HTTP/HTTPS/WS/WSS proxy Chrome is launched through, so a value can be
 * held and served back in place of what the server would say.
 *
 * Observation stays on CDP, which sees what the renderer receives including
 * cache hits and service-worker replies. This exists for intervention only.
 *
 * Nothing is parsed unless it is pinned. An unpinned request is forwarded and
 * its bytes are piped back untouched - no decompression, no chunk handling, no
 * header rewriting - so the correctness surface is exactly the traffic asked
 * for. A half-right proxy corrupts responses in ways that are miserable to
 * find; a byte pipe cannot.
 */
import { createServer as createHttpServer, request as httpRequest, type IncomingMessage, type ServerResponse } from 'http';
import { createServer as createHttpsServer } from 'https';
import { request as httpsRequest } from 'https';
import { connect as netConnect, type Socket } from 'net';
import { WebSocketServer, WebSocket } from 'ws';
import { mintProxyCertificate, type ProxyCertificate } from './certificate.js';

/** A value held in place of what the server would answer. */
export interface Pin {
  id: string;
  /** Matched as a substring of the full URL. */
  urlIncludes: string;
  /** Only this method, when given. */
  method?: string;
  /**
   * Only under this replay step, when given.
   *
   * A pin with no step answers its URL at every position in a run, so a
   * request the server would refuse for arriving out of order is served over.
   * Bound to a step, the pin answers at the position it was staged under and
   * the same request at another position reaches the server, or the refusal
   * below, and fails where the recording did not.
   */
  step?: number;
  status: number;
  headers: Record<string, string>;
  body: string;
  /** Times it has answered, so a pin that never fires is visible as one. */
  hits: number;
}

/** Methods that read: an unmatched one is forwarded under every mode. */
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

export interface SocketFrame {
  at: number;
  url: string;
  direction: 'sent' | 'received';
  binary: boolean;
  size: number;
  /** Text frames only, truncated by the caller's own rule. */
  text?: string;
  /** What the proxy did with it. Absent means it went through unchanged. */
  heldAs?: 'replaced' | 'dropped';
}

/**
 * One thing the proxy saw cross the boundary.
 *
 * Requests and frames are one kind here rather than two, because what is
 * wanted between two steps is "what reached the outside world", and that
 * question does not care which transport carried it.
 */
export interface ProxyEvent {
  id: string;
  at: number;
  kind: 'request' | 'frame';
  /** Leaving the browser, or arriving at it. */
  direction: 'out' | 'in';
  url: string;
  method?: string;
  status?: number;
  binary?: boolean;
  /** Response body bytes for a request, payload bytes for a frame. */
  size: number;
  contentType?: string;
  /** Request issued to response complete. Absent for a frame, which is a point. */
  durationMs?: number;
  /**
   * The response is still arriving.
   *
   * An event stream or a long poll is on the record from its headers, because
   * waiting for the end would leave it invisible for exactly as long as it
   * matters. The size and duration grow while this stands.
   */
  open?: boolean;
  /**
   * When a request arrived at the proxy, which is what an initiator reported by
   * the page is matched against. A response completes later and by then several
   * requests to the same URL may have started, so completion time cannot key
   * the match.
   */
  startedAt?: number;
  /** First characters of the payload, for a list. The whole body is kept
   *  separately and only up to BODY_CAP. */
  preview?: string;
  heldAs?: 'replaced' | 'dropped' | 'refused';
  /**
   * The history command in flight when this crossed, while a person drives.
   *
   * Stamped at capture, not derived at read. A request takes the cursor as it
   * arrives, so a response completing after the next command began still
   * carries the command that issued it. A received frame takes the cursor
   * where it stands, which is the rule the evidence-timeline skill sets: a
   * frame belongs to the command it arrived under, not to whichever command
   * opened the socket.
   *
   * Absent on traffic a replay produced, which carries `runId` and `step`.
   */
  commandIndex?: number;
  /**
   * The replay pass that produced this, and the step within it.
   *
   * Separate from `commandIndex` because a repeated step reuses its original
   * history index: without the pass, a replay's traffic and the recording's
   * traffic carry the same stamp and the two cannot be told apart, which is
   * the comparison a replay exists to make.
   */
  runId?: string;
  step?: number;
  /**
   * How much the stamp above claims about cause.
   *
   * Computed from `evidence` by `levelOf`, not stored. Kept on the event only
   * where a reader wants the current policy's answer beside the fields.
   *
   * observed   - a payload id ties this arrival to a send.
   * likely     - consumed a send's outstanding allowance, and carries that
   *              send's command rather than the one it landed under.
   * positional - the stamp says when this crossed, not what caused it.
   * unprompted - nothing accounts for it: an arrival with no send outstanding
   *              on its socket, or a request the page says a timer asked for.
   */
  confidence?: EventConfidence;
  /** What was measured. The level above is a reading of this. */
  evidence?: EventEvidence;
}

export type EventConfidence = 'observed' | 'likely' | 'positional' | 'unprompted';

/**
 * What was measured about one event when it crossed.
 *
 * Stored in place of a verdict. A level is a reading of these fields and the
 * rule producing it has been rewritten three times; an event captured under an
 * earlier rule keeps whatever that rule wrote, so the rule is applied at read
 * and these fields are what it reads.
 */
export interface EventEvidence {
  /** For an arrival matched to a send: how it matched, and that send. */
  pairing?: {
    how: 'id' | 'allowance';
    sentUnder?: ProxyCursor;
    /** Between the send crossing and this arrival crossing. */
    afterMs: number;
  };
  /** Sends whose allowance expired before this arrival was accounted. */
  agedOut?: number;
  /** This socket has paired an arrival to a send by id, so ids are authoritative. */
  socketPairs?: boolean;
  /** The socket's counts as this crossed. */
  socket?: { sent: number; received: number; paired: number; unprompted: number };
  /** Payload class, for grouping arrivals that are the same kind of message. */
  shape?: string;
  /** The protocol paired request to response, rather than anything naming a cause. */
  protocolPaired?: boolean;
  /** What started this request, read from the page rather than from the wire. */
  initiator?: InitiatorRoot;
  /**
   * The document whose markup named this request, for a parser or preload root.
   *
   * A subresource starts whenever the parser reaches it, which is often after
   * the command that navigated has returned. The document names the load, so
   * the request is owned through it rather than through the clock.
   */
  initiatedBy?: string;
}

/**
 * What started a request, as the page reports it.
 *
 * The proxy sees bytes leaving under whatever cursor stands. These classes
 * separate a request a command caused from one the app produces on its own,
 * which the cursor alone cannot do.
 *
 * parser  - the document's own markup asked for it, so it belongs to the
 *           navigation that loaded that document however late it starts.
 * preload - the preload scanner asked for it, which is the same navigation.
 * timer   - a `setTimeout`, `setInterval` or animation frame asked for it, so
 *           it runs on the app's schedule and no command caused it.
 * script  - script asked for it with no timer above it in the stack.
 * other   - the page named something none of the above covers.
 */
export type InitiatorRoot =
  | 'parser' | 'preload' | 'timer' | 'script' | 'other'
  /**
   * A user gesture was being dispatched when this left.
   *
   * The page reports an event that is both trusted - browser-generated rather
   * than synthesised by script - and of a type `Input.dispatch*` produces. On a
   * driven browser that gesture is the harness's, so the command driving it
   * caused this. A person at the keyboard produces the same measurement, and
   * `mark`'s window is what keeps it from reaching a command long finished.
   */
  | 'input';

/**
 * The class of a payload: what makes two frames the same kind of message.
 *
 * Top-level key set for JSON, a length band for anything else. Deliberately
 * coarse - it groups a stream's frames together so a rule or a count applies
 * to the class rather than to one frame.
 */
export function payloadShape(text: string | undefined, binary: boolean, size: number): string {
  const band = size < 128 ? 'xs' : size < 2048 ? 's' : size < 65536 ? 'm' : 'l';
  if (binary) return `bin:${band}`;
  if (text === undefined || text.length === 0) return `text:${band}`;

  // Engine.IO and Socket.IO put digits before the payload, and Phoenix sends
  // arrays. Neither is a JSON object, so a size band alone would put a
  // heartbeat and every data message on the socket in one bucket - and one
  // rule assigned there would zero the whole socket.
  const enginePrefix = /^(\d+)(.*)$/s.exec(text);
  if (enginePrefix && (text[0] < '0' || text[0] > '9') === false) {
    const [, digits, rest] = enginePrefix;
    const inner = shapeOfJson(rest);
    return inner ? `eio${digits}:${inner}` : `eio${digits}:${band}`;
  }
  const direct = shapeOfJson(text);
  return direct ?? `text:${band}`;
}

/** One top-level member of a JSON object, as a frame pin compares it. */
export interface FrameField {
  key: string;
  value: unknown;
}

/**
 * The field a match text names, where it is exactly one `"key":value` pair.
 *
 * Wrapped in braces it is a JSON object with one member. Text that wraps to
 * anything else - two members, a bare key, a Socket.IO event name, prose -
 * names no field and is matched as a substring.
 */
export function fieldOf(text: string): FrameField | undefined {
  if (!/^\s*"/.test(text)) return undefined;
  try {
    const parsed = JSON.parse(`{${text}}`);
    const keys = Object.keys(parsed);
    if (keys.length !== 1) return undefined;
    return { key: keys[0], value: parsed[keys[0]] };
  } catch {
    return undefined;
  }
}

/**
 * The top-level object of a text frame: bare JSON, or JSON behind the digits
 * Engine.IO and Socket.IO put before a packet. Arrays and everything else
 * carry no top-level field.
 */
export function objectOf(text: string): Record<string, unknown> | undefined {
  const body = text.replace(/^\d+/, '');
  if (body[0] !== '{') return undefined;
  try {
    const parsed = JSON.parse(body);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/** Whether an object carries the field: same key, same value, compared as JSON. */
export function carries(object: Record<string, unknown>, field: FrameField): boolean {
  if (!(field.key in object)) return false;
  const held = object[field.key];
  if (held === null || typeof held !== 'object') return held === field.value;
  return JSON.stringify(held) === JSON.stringify(field.value);
}

/** The key set of a JSON object, or the event name of a JSON array. */
function shapeOfJson(text: string): string | undefined {
  const head = text[0];
  if (head !== '{' && head !== '[') return undefined;
  try {
    const parsed = JSON.parse(text);
    if (Array.isArray(parsed)) {
      // Phoenix is [join_ref, ref, topic, event, payload]; Socket.IO is
      // [event, ...args]. The names are what separate one message from
      // another. Numeric strings are dropped: Phoenix's ref increments per
      // message, so keeping it would give every frame its own shape and no
      // rule would ever apply twice.
      // Phoenix is [join_ref, ref, topic, event, payload] - the topic carries
      // an entity id, so it is stripped, and the event names the message.
      if (parsed.length === 5 && typeof parsed[2] === 'string' && typeof parsed[3] === 'string') {
        return `arr:${(parsed[2] as string).split(':')[0]},${parsed[3]}`;
      }
      // Socket.IO is [event, ...args]. The first string is the event; the rest
      // is payload, and joining it would give every message its own shape.
      const named = parsed.find(
        (part): part is string => typeof part === 'string' && !/^\d+$/.test(part));
      return named !== undefined ? `arr:${named}` : `arr:${parsed.length}`;
    }
    if (parsed && typeof parsed === 'object') {
      return `json:${Object.keys(parsed).sort().join(',')}`;
    }
  } catch { /* not JSON */ }
  return undefined;
}

/**
 * The cursor a step owns this event under: the send that caused it where one
 * paired, otherwise where it crossed.
 *
 * Bucketing on arrival alone puts an answer in whichever step it landed
 * under, which is the timing sensitivity the stamps exist to remove.
 */
export function causeOf(event: ProxyEvent): ProxyCursor | undefined {
  const paired = event.evidence?.pairing?.sentUnder;
  if (paired) return paired;
  // The page named a timer as what asked for this, so no command caused it and
  // it belongs to no step. Left in the bucket it crossed under it would weigh
  // nothing and still be counted as present, and a poll firing a different
  // number of times on replay would read as changed behaviour.
  //
  // This reaches what the page can report on, which is what the browser sent:
  // a polled request and a client heartbeat. A frame the server pushed carries
  // no root - nothing in the page or the wire says what the server's own
  // schedule is - so it stays in the bucket it crossed under, weighing nothing
  // and counted as present. That is deliberate: presence is how a server that
  // stopped pushing is visible at all, and a person ruling the shape
  // `background` is the control for a push whose count moves with pacing.
  if (event.evidence?.initiator === 'timer') return undefined;
  if (event.runId !== undefined) return { kind: 'replay', runId: event.runId, step: event.step ?? 0 };
  if (event.commandIndex !== undefined) return { kind: 'command', index: event.commandIndex };
  return undefined;
}

/**
 * The level a policy reads off an event's evidence.
 *
 * The only rule today. A different tolerance is a different function over the
 * same fields, applied to records already captured.
 */
export function levelOf(event: Pick<ProxyEvent, 'kind' | 'direction' | 'evidence'>): EventConfidence {
  const e = event.evidence;
  // The page named a timer as what asked for this, so it runs on the app's own
  // schedule and no command caused it. Measured, where the cursor says only
  // that it crossed while that command was in flight.
  if (e?.initiator === 'timer') return 'unprompted';
  // The page measured a user gesture dispatching when this left, and a command
  // drove that gesture. That is a measurement of cause, where a cursor says
  // only that the two overlapped - so it reads above `positional`, which is
  // what every other request and every send gets.
  if (e?.initiator === 'input') return 'likely';
  if (event.kind === 'request') return 'positional';
  if (event.direction === 'out') return 'positional';
  if (e?.pairing?.how === 'id') return 'observed';
  if (e?.pairing?.how === 'allowance') return 'likely';
  if (e?.agedOut) return 'positional';
  return 'unprompted';
}

/**
 * What one socket did, counted rather than inferred.
 *
 * Attribution by arrival is sound on a socket that only answers, and
 * meaningless on one that speaks unasked. Which of those a socket is cannot be
 * assumed from its URL, so it is measured.
 */
export interface SocketProfile {
  url: string;
  sent: number;
  received: number;
  /** Sends refused an allowance because the queue was full. */
  allowancesRefused: number;
  /**
   * Sends the page reported a timer opened, which account for no arrival.
   *
   * Counted rather than queued: a heartbeat answers nothing, and an allowance
   * for it would let the next pushed frame read as its answer.
   */
  sentUnprompted: number;
  /** Arrivals paired to a send by an id both frames carried. */
  paired: number;
  /**
   * Arrived after every outstanding send had aged out of its allowance.
   *
   * Whether such an arrival answers one of them is not measurable, so it
   * claims nothing and does not make the socket `push`: one slow reply is a
   * slow reply, not evidence that the server speaks unasked.
   */
  receivedLate: number;
  /**
   * Arrived with no send outstanding to account for it.
   *
   * A send opens an allowance of one and an arrival consumes it. Five answers
   * to one request and a stream after one subscribe are the same shape on the
   * wire - one send, many arrivals - so everything past the first is counted
   * here rather than credited to the send.
   */
  receivedUnprompted: number;
  /** Longest run of arrivals between two sends. */
  longestRun: number;
}

/**
 * idle - nothing arrived, so there is nothing to attribute.
 * reply - every arrival was accounted to an outstanding send.
 * push - something arrived with no send outstanding, so the socket produces
 *        frames of its own and arrival on it names no cause.
 */
export type SocketShape = 'idle' | 'reply' | 'push';

export function shapeOf(profile: SocketProfile): SocketShape {
  if (profile.received === 0) return 'idle';
  if (profile.receivedUnprompted > 0) return 'push';
  return 'reply';
}

/**
 * What a person decided one payload shape is, having watched it arrive.
 *
 * step       - the step running when it arrived caused it
 * send       - the send it followed caused it
 * background - the app produces it on its own; it belongs to no step
 * unknown    - nobody could tell, and that stays on the record
 */
export type ShapeVerdict = 'step' | 'send' | 'background' | 'unknown';

/** Rules a person assigned, keyed by payload shape. */
export type ShapeRules = Record<string, ShapeVerdict>;

/**
 * How much of an event a step owns, by what backs its level.
 *
 * Ownership is graded rather than decided. A false pairing then costs a
 * fraction of a point in a comparison instead of moving a whole event onto the
 * wrong step, and an arrival nothing accounts for contributes nothing rather
 * than being assigned somewhere for tidiness.
 */
export function ownershipWeight(
  event: Pick<ProxyEvent, 'kind' | 'direction' | 'evidence'>,
  rules?: ShapeRules
): number {
  // A person who watched it arrive outranks any reading of the wire. Their
  // answer is stored per shape, so one decision settles every later frame of
  // that kind rather than one frame.
  const assigned = event.evidence?.shape ? rules?.[event.evidence.shape] : undefined;
  if (assigned === 'step' || assigned === 'send') return 1;
  if (assigned === 'background' || assigned === 'unknown') return 0;
  switch (levelOf(event)) {
    case 'observed': return 1;
    case 'likely': return 0.7;
    case 'positional': return 0.3;
    case 'unprompted': return 0;
  }
}

/**
 * What crossed, as weighted counts per payload shape.
 *
 * Shapes rather than a total: a step whose traffic changed entirely while its
 * count held reads as no drift against a count, and reads as two differences
 * against this.
 */
export function weighShapes(events: ProxyEvent[], rules?: ShapeRules): Record<string, number> {
  return tallyShapes(events, rules).weight;
}

/**
 * What crossed, as ownership weight and as a plain count, per shape.
 *
 * Two numbers because they answer different questions. Weight is how much of
 * it this step owns, and a push it does not own weighs nothing. Count is
 * whether it crossed at all, and a step that received four pushes while
 * recording and none on replay is a difference whatever it owned.
 */
export function tallyShapes(
  events: ProxyEvent[],
  rules?: ShapeRules
): { weight: Record<string, number>; seen: Record<string, number> } {
  const weight: Record<string, number> = {};
  const seen: Record<string, number> = {};
  for (const event of events) {
    const shape = shapeKey(event);
    // A shape someone ruled background or unknown is left out of the count as
    // well as the weight. It arrives on its own schedule, so its count moves
    // with how long a step happened to take and a difference says nothing.
    const ruled = rules?.[shape];
    if (ruled !== 'background' && ruled !== 'unknown') {
      seen[shape] = (seen[shape] ?? 0) + 1;
    }
    const owned = ownershipWeight(event, rules);
    if (owned === 0) continue;
    weight[shape] = Math.round(((weight[shape] ?? 0) + owned) * 100) / 100;
  }
  return { weight, seen };
}

/** The bucket an event counts in. A request names its path, not just a method. */
function shapeKey(event: ProxyEvent): string {
  if (event.evidence?.shape) return event.evidence.shape;
  if (event.kind !== 'request') return 'frame';
  let path = event.url;
  try { path = new URL(event.url).pathname; } catch { /* not a URL to split */ }
  return `http:${event.method ?? 'GET'} ${path}`;
}

/** What a later event carries: one live command, or one step of one replay. */
export type ProxyCursor =
  | { kind: 'command'; index: number }
  | { kind: 'replay'; runId: string; step: number };

/**
 * Hosts the browser talks to on its own account, refused outright.
 *
 * Chrome's own traffic goes through this proxy too, and there is far more of
 * it than the app's: measured on one launch, 29 events of 35 were Chrome
 * talking to Google. Flags cut it and none of them reach zero - the New Tab
 * page, GCM check-in and update pings survive every switch there is.
 *
 * Matched on the host's suffix. Deliberately narrow: these are browser
 * services an application does not call. Ambiguous hosts an app might really
 * use - accounts.google.com for sign-in, fonts and gstatic for assets - are
 * left alone, because blocking one silently breaks the thing under test.
 */
const BROWSER_SERVICE_HOSTS = [
  // Host and path, for services living on a host an application may also use.
  // The New Tab page, the omnibox and the browser's sign-in state all call
  // google.com, and an application does not call these paths.
  'www.google.com/async/',
  'www.google.com/complete/search',
  'accounts.google.com/ListAccounts',
  'clients1.google.com',
  'clients2.google.com',
  'clients3.google.com',
  'clients4.google.com',
  'clients5.google.com',
  'clients6.google.com',
  'update.googleapis.com',
  'clientservices.googleapis.com',
  'optimizationguide-pa.googleapis.com',
  'safebrowsing.googleapis.com',
  'content-autofill.googleapis.com',
  'android.clients.google.com',
  'gvt1.com',
  'gvt2.com',
];

/**
 * How long a send keeps an allowance open for an answer.
 *
 * A send that is never answered - a typing indicator, a fire-and-forget
 * notice - would otherwise hold its allowance forever, and the next frame the
 * server pushed on its own would consume it and read as an answer. The bound
 * is arbitrary and deliberately generous: it stops laundering across minutes,
 * not across a slow reply. A payload pairing removes the need for it.
 */
const ALLOWANCE_MS = 10_000;
/** Sent ids held for pairing, before the oldest is dropped. */
const MAX_PENDING_IDS = 256;

/**
 * The id a frame carries for pairing, where it carries one.
 *
 * JSON-RPC, GraphQL over WebSocket and several others put a top-level `id` on
 * both the request and everything answering it. A frame that parses as an
 * object with a string or number `id` yields it; everything else yields
 * nothing and the socket falls back to allowance accounting.
 */
export function pairingId(text: string | undefined): string | undefined {
  if (text === undefined || text.length === 0 || text.length > 64 * 1024) return undefined;
  if (text[0] !== '{') return undefined;
  try {
    const parsed = JSON.parse(text);
    const id = parsed?.id;
    if (typeof id === 'string' && id.length > 0) return id;
    if (typeof id === 'number' && Number.isFinite(id)) return String(id);
  } catch { /* not JSON; nothing to pair on */ }
  return undefined;
}
/**
 * A close code that may be put in a close frame.
 *
 * 1005 and 1006 are what an endpoint reports when it never received a code - a
 * destroyed transport is 1006 - and 1004 and 1015 are reserved. None of them
 * may be sent, and `ws` throws on them, so forwarding one verbatim closed
 * nothing: the browser's socket stayed open for the life of the page while its
 * other half was already gone, and every later frame the page sent went
 * nowhere. 1011 carries a meaning the peer can act on.
 */
function sendableCloseCode(code: number): number {
  if (code === 1004 || code === 1005 || code === 1006 || code === 1015) return 1011;
  if (code >= 1000 && code < 5000) return code;
  return 1011;
}

/** Sends held waiting for an answer, before the oldest is dropped. */
const MAX_ALLOWANCES = 64;
/** How far apart a request and the page's report of it may start and still be one. */
const JOIN_WINDOW_MS = 4000;
/** Events scanned back for a request a late report belongs to. */
const JOIN_SCAN = 200;
/** Reports held for a request that has not crossed yet. */
const MAX_REPORTED_INITIATORS = 200;
/** How far apart a send and the page's report of it may be and still be one. */
const JOIN_SEND_MS = 2000;
/**
 * How long after a command returns a gesture it drove can still be credited to
 * it. A page's own work settles in well under this; a person's gesture minutes
 * later is past it and owns nothing.
 */
const GESTURE_REACH_MS = 5000;
/** Send reports held per socket for frames that have not crossed yet. */
const MAX_REPORTED_SENDS = 64;

/**
 * What one live socket holds that something outside its closure reads.
 *
 * The page reports a send over a CDP session while its bytes cross the wire,
 * so a report can land either side of the frame. Both paths reach the same
 * allowance queue through this.
 */
interface SocketLedger {
  url: string;
  allowances: Array<{ cursor: ProxyCursor | undefined; at: number; size?: number }>;
  /**
   * Reports whose frame has not crossed yet, by this socket's send sequence.
   *
   * Keyed by sequence rather than size: two sends of one size would otherwise
   * swap roots, and a report nothing claimed would be taken by whichever later
   * frame happened to share its length.
   */
  reportedSends: Map<number, { size: number; root: 'input' | 'timer' | 'script'; at: number }>;
  /**
   * Frames this socket has sent, with the event each produced. Bounded, so it
   * cannot carry the count - `sentCount` does, and a sequence read off this
   * array's length would repeat once the oldest entries are dropped.
   */
  sent: Array<{ sequence: number; size: number; event: ProxyEvent | undefined }>;
  /** How many frames this socket has sent, never reduced. */
  sentCount: number;
  /** Counted here as well as at the frame, since a report lands either side. */
  profile: SocketProfile;
}

/**
 * The report for this socket's Nth send, where it arrived before the frame.
 *
 * The size is checked rather than matched on: a mismatch means the page's
 * count and the proxy's have diverged - a send the page made that never
 * reached the wire, or one the proxy saw that the page did not report - and a
 * root taken from a diverged sequence would name the wrong send. Dropping it
 * leaves the frame unmeasured, which reads as positional rather than wrong.
 */
function takeReportedSend(
  ledger: SocketLedger, sequence: number, size: number
): 'input' | 'timer' | 'script' | undefined {
  const held = ledger.reportedSends.get(sequence);
  if (!held) return undefined;
  ledger.reportedSends.delete(sequence);
  if (held.size !== size && held.size >= 0) return undefined;
  if (Date.now() - held.at > JOIN_SEND_MS) return undefined;
  return held.root;
}

/**
 * Take back the allowance a send opened, where no arrival has spent it.
 *
 * The newest matching one, because a report lands within milliseconds of its
 * own frame. An allowance already consumed is not recoverable: the arrival
 * that spent it carries that send's command and stays as recorded.
 */
function withdrawAllowance(ledger: SocketLedger, size: number): void {
  for (let i = ledger.allowances.length - 1; i >= 0; i--) {
    if (ledger.allowances[i].size !== size) continue;
    ledger.allowances.splice(i, 1);
    return;
  }
}

/**
 * The socket a report belongs to, among those on its URL.
 *
 * The page counts sockets per document and the proxy counts them per
 * connection, so the two numbers do not line up and the URL alone does not
 * separate two components subscribed to one endpoint. The send sequence does:
 * a report for the Nth send belongs to a socket that has sent N frames, and
 * the size of that frame confirms it.
 *
 * Nothing is returned where two sockets fit equally. A report applied to the
 * wrong socket withdraws an allowance that socket never opened and leaves the
 * real one standing, which turns an unprompted push into an answer - worse
 * than leaving the send unmeasured.
 */
function ledgerFor(
  ledgers: Set<SocketLedger>, bound: Map<number, SocketLedger>,
  url: string, socket: number, sequence: number, size: number
): SocketLedger | undefined {
  // Once a page's socket number has been matched to a ledger, every later
  // report from it routes straight there - the page counts its own sockets in
  // order and so does the proxy, but the two counts start from different sets,
  // so the pairing is learned rather than assumed.
  const already = bound.get(socket);
  if (already && ledgers.has(already) && already.url === url) return already;

  const onUrl: SocketLedger[] = [];
  for (const ledger of ledgers) if (ledger.url === url) onUrl.push(ledger);
  if (onUrl.length === 0) return undefined;
  if (onUrl.length === 1) {
    if (socket > 0) bound.set(socket, onUrl[0]);
    return onUrl[0];
  }
  // A frame of that size already sent as this socket's Nth is the evidence.
  // Falling back to a socket that has simply not sent that many yet would fit
  // any silent socket on the URL, which is how a report reaches one that sent
  // nothing.
  const fitting = onUrl.filter(ledger =>
    ledger.sent.find(s => s.sequence === sequence)?.size === size);
  if (fitting.length === 1) {
    if (socket > 0) bound.set(socket, fitting[0]);
    return fitting[0];
  }
  // Nothing fits uniquely. A report applied to the wrong socket withdraws an
  // allowance that socket never opened and leaves the real one standing, which
  // turns an unprompted push into an answer - worse than an unmeasured send.
  const waiting = onUrl.filter(ledger =>
    ledger.sentCount < sequence && ledger.sent.length === ledger.sentCount);
  return fitting.length === 0 && waiting.length === 1 ? waiting[0] : undefined;
}
/** Sockets profiled before the oldest is discarded. */
const MAX_PROFILES = 200;
/** Events held before the oldest is discarded. */
const MAX_EVENTS = 2000;
/** Response body kept per exchange, for turning one into a held value later. */
const BODY_CAP = 64 * 1024;
const PREVIEW_CHARS = 200;

/**
 * A frame held in place of what would have crossed.
 *
 * Matched on the payload rather than on position: a socket carries no method,
 * URL or status, so the only durable handle on one message is what is in it.
 */
export interface FramePin {
  id: string;
  /** Substring of the connection's URL, when the hold is for one socket. */
  urlIncludes?: string;
  direction?: 'sent' | 'received';
  /**
   * What the payload has to carry. Binary frames are never matched.
   *
   * One `"key":value` pair is read as `field` and compared against the
   * frame's top-level JSON; anything else is a substring of the text. The
   * form is the whole of the choice, so `"tag":"ready"` matches the field and
   * `tag":"ready` matches the characters.
   */
  textIncludes: string;
  /**
   * Read off `textIncludes` at arming, never supplied. On a frame that parses
   * as a JSON object this decides the match: `"i":1` is carried by `{"i":1}`
   * and not by `{"i":10}` or by `{"x":{"i":1}}`, where the substring is
   * carried by all three. On a frame that does not parse, the substring
   * decides.
   */
  field?: FrameField;
  /** Only under this replay step, when given; see `Pin.step`. */
  step?: number;
  /** Sent in its place. Absent drops the frame, and nothing arrives at all. */
  replaceWith?: string;
  hits: number;
}

export class InterceptProxy {
  private certificate: ProxyCertificate | null = null;
  private front = createHttpServer();
  /** Fed sockets after CONNECT rather than listening; it terminates the TLS. */
  private inner = createHttpsServer();
  /** The same, for a CONNECT tunnel that turns out to carry no TLS. */
  private innerPlain = createHttpServer();
  /**
   * The client's chosen subprotocol is echoed back, and forwarded upstream at
   * the socket below. Without it a server that requires one - GraphQL over WS,
   * STOMP - refuses the proxied connection, and the protocol name that bounds
   * payload pairing never arrives. The first requested is taken: the client
   * handshake settles before the upstream one, so the server's own choice is
   * not available yet.
   */
  private upgrades = new WebSocketServer({
    noServer: true,
    handleProtocols: (protocols) => [...protocols][0] ?? false,
  });
  private pins = new Map<string, Pin>();
  private framePins = new Map<string, FramePin>();
  private events: ProxyEvent[] = [];
  private bodies = new Map<string, string>();
  private profiles: SocketProfile[] = [];
  /** When the last event was recorded, for settling a step boundary. */
  private lastEventAt = 0;
  /**
   * Highest command whose events the ring has dropped.
   *
   * A step at or below this saw events that are gone, which is not the same
   * as a step that saw none - and storing an empty set for it would compare
   * as "nothing crossed" on every later replay.
   */
  private evictedThrough = -1;
  /** What a person decided about each payload shape on this browser. */
  private rules: ShapeRules = {};
  private eventSeq = 0;
  /** What is in flight, stamped onto each event as it is captured. */
  private cursor: ProxyCursor | undefined;
  /** The last cursor marked and when, held past its clear; see `mark`. */
  private lastMarked: { cursor: ProxyCursor; at: number } | undefined;
  private blockedHosts = [...BROWSER_SERVICE_HOSTS];
  private allowedHosts: string[] = [];
  /** Allowed through and left out of the record: devharness's own servers. */
  private quietHosts: string[] = [];
  private blockedCount = 0;
  private refusedHosts = new Map<string, number>();
  private refuseWrites = false;
  private refusedWriteCount = 0;
  private frameHandlers = new Set<(frame: SocketFrame) => void>();
  private pinSeq = 0;
  private port = 0;

  /** The port Chrome is pointed at. */
  get listenPort(): number {
    return this.port;
  }

  /** How many calls were refused, and to where. */
  get blocked(): number {
    return this.blockedCount;
  }

  /** Refused hosts and their counts, so a black hole is visible, not silent. */
  refusals(): Array<{ host: string; count: number }> {
    return [...this.refusedHosts.entries()]
      .map(([host, count]) => ({ host, count }))
      .sort((a, b) => b.count - a.count);
  }

  /**
   * Let only these through; everything else is refused.
   *
   * An entry is a host, matching any port on it and its subdomains, or a
   * host:port, matching exactly that. Set this and the refused-host list stops
   * being consulted: an allow list answers the same question with the opposite
   * default, and consulting both would leave two places to look when something
   * unexpectedly cannot reach the network.
   */
  allowOnly(hosts: string[]): void {
    // The quiet hosts are devharness's own servers. Dropping them here would
    // refuse the bench the moment an allow list is set, whichever order the
    // two calls arrive in.
    const quiet = this.quietHosts.filter(host => !hosts.includes(host));
    this.allowedHosts = [...hosts, ...quiet];
  }

  listAllowedHosts(): string[] {
    return [...this.allowedHosts];
  }

  /**
   * Refuse every unmatched request whose method writes, or forward it.
   *
   * The allow list bounds hosts, and the app's own host is on it by
   * construction, so a write to the app no pin answers is forwarded and the
   * server acts on it. With this on, such a request is answered 403 and
   * recorded as `refused`, so "this run writes nothing the rules do not
   * answer" is a bound the proxy holds rather than a property of the rule
   * set. Reads are forwarded under either setting.
   */
  refuseUnmatchedWrites(on: boolean): void {
    this.refuseWrites = on;
  }

  get refusesWrites(): boolean {
    return this.refuseWrites;
  }

  /** Writes answered 403 under `refuseUnmatchedWrites`. */
  get refusedWrites(): number {
    return this.refusedWriteCount;
  }

  /**
   * Reach the network, and stay out of the record.
   *
   * devharness's own servers travel the same proxy as the app: the control
   * pane is on loopback like everything else. Refusing them breaks the pane,
   * and recording them buries the app's traffic under the pane's own polling.
   */
  allowQuietly(hosts: string[]): void {
    for (const host of hosts) {
      if (!this.quietHosts.includes(host)) this.quietHosts.push(host);
      // Only joins an allow list that already exists. Pushing into an empty
      // one turns "allow everything" into "allow nothing but the bench", and
      // the app under test is black-holed by the act of opening the bench.
      if (this.allowedHosts.length > 0 && !this.allowedHosts.includes(host)) {
        this.allowedHosts.push(host);
      }
    }
  }

  private isQuiet(host: string): boolean {
    const name = host.split(':')[0].toLowerCase();
    const port = host.split(':')[1];
    return this.quietHosts.some(entry => {
      const [wantHost, wantPort] = entry.toLowerCase().split(':');
      return (name === wantHost || name.endsWith(`.${wantHost}`))
        && (wantPort === undefined || wantPort === port);
    });
  }

  /** Replace the refused-host list; [] lets the browser talk freely. */
  setBlockedHosts(hosts: string[]): void {
    this.blockedHosts = [...hosts];
  }

  listBlockedHosts(): string[] {
    return [...this.blockedHosts];
  }

  /**
   * Whether this is the browser talking on its own account.
   *
   * An entry with no slash matches the host and its subdomains. An entry with
   * one matches a host and a path prefix, which is how a browser service on a
   * host an application also uses is refused without refusing the application.
   */
  private isBrowserService(host: string, path?: string): boolean {
    const name = host.split(':')[0].toLowerCase();
    const port = host.split(':')[1];

    if (this.allowedHosts.length > 0) {
      const allowed = this.allowedHosts.some(entry => {
        const [wantHost, wantPort] = entry.toLowerCase().split(':');
        const hostMatches = name === wantHost || name.endsWith(`.${wantHost}`);
        return hostMatches && (wantPort === undefined || wantPort === port);
      });
      return !allowed;
    }

    return this.blockedHosts.some(blocked => {
      const cut = blocked.indexOf('/');
      if (cut < 0) return name === blocked || name.endsWith(`.${blocked}`);
      if (path === undefined) return false;
      const wantHost = blocked.slice(0, cut);
      return (name === wantHost || name.endsWith(`.${wantHost}`)) && path.startsWith(blocked.slice(cut));
    });
  }

  private noteRefusal(host: string): void {
    this.blockedCount += 1;
    this.refusedHosts.set(host, (this.refusedHosts.get(host) ?? 0) + 1);
  }

  /**
   * Advance the cursor that every later event carries.
   *
   * Called before the command or replayed step executes, so the traffic it
   * produces is stamped with it rather than with the one before it.
   */
  mark(cursor: ProxyCursor | undefined): void {
    this.cursor = cursor;
    // Kept past the clear, for traffic the page attributes after the fact: a
    // request the page reports as started inside a user gesture belongs to the
    // command that drove that gesture, even when its bytes leave after the
    // release. Held with the time it was marked, because the claim weakens with
    // distance - a gesture minutes after a command returned was a person's, not
    // that command's, and crediting it would put the app's own behaviour inside
    // a step for the rest of the session.
    if (cursor) this.lastMarked = { cursor, at: Date.now() };
  }

  /** Record what a person decided one payload shape is. */
  assignShape(shape: string, verdict: ShapeVerdict): void {
    this.rules[shape] = verdict;
  }

  /**
   * Record what the page reported started one request.
   *
   * The report comes from a CDP session and the request from the wire, and the
   * two carry no shared id, so they are matched on method, URL and start time.
   * Either can arrive first: a report with no request yet is held until one
   * crosses, and a request already recorded takes the report directly.
   */
  noteInitiator(
    method: string, url: string, root: InitiatorRoot, at: number, document?: string
  ): void {
    const key = `${method.toUpperCase()} ${url}`;
    for (let i = this.events.length - 1; i >= 0 && i > this.events.length - JOIN_SCAN; i--) {
      const event = this.events[i];
      if (event.kind !== 'request') continue;
      // A root already stands unless this one is `input`, which outranks every
      // other: CDP reads the stack and cannot see that an event was being
      // dispatched, and that is the only thing tying a request to the command
      // that drove the page.
      const standing = event.evidence?.initiator;
      if (standing !== undefined && !(root === 'input' && standing !== 'input')) continue;
      if (`${(event.method ?? 'GET').toUpperCase()} ${event.url}` !== key) continue;
      if (Math.abs((event.startedAt ?? event.at) - at) > JOIN_WINDOW_MS) continue;
      const evidence = (event.evidence ??= {});
      evidence.initiator = root;
      if (document) evidence.initiatedBy = document;
      this.attributeFromPage(event);
      return;
    }
    this.reportedInitiators.push({ key, root, at, document });
    if (this.reportedInitiators.length > MAX_REPORTED_INITIATORS) {
      this.reportedInitiators.splice(0, this.reportedInitiators.length - MAX_REPORTED_INITIATORS);
    }
  }

  /**
   * Give a subresource the stamp its document carries, where it has none.
   *
   * The parser reaches a subresource whenever it reaches it, which is often
   * after the command that navigated returned and its boundary was released.
   * The document request crossed under that command, so the stamp is copied
   * from it: the load is owned by what caused it rather than by whichever
   * command happened to be in flight, or by none at all.
   */
  private attributeFromPage(event: ProxyEvent): void {
    const root = event.evidence?.initiator;
    if (event.commandIndex !== undefined || event.runId !== undefined) return;
    // Started inside a user gesture. A command drives the gesture, so the
    // command last marked is the one that caused it however late the bytes
    // left - while that command is recent enough for the claim to hold. Past
    // the window the gesture was somebody's own and the request owns nothing,
    // which reads as the app's traffic rather than as a step's.
    if (root === 'input') {
      const marked = this.lastMarked;
      if (!marked || Date.now() - marked.at > GESTURE_REACH_MS) return;
      if (marked.cursor.kind === 'command') event.commandIndex = marked.cursor.index;
      if (marked.cursor.kind === 'replay') {
        event.runId = marked.cursor.runId;
        event.step = marked.cursor.step;
      }
      return;
    }
    if (root !== 'parser' && root !== 'preload') return;
    const document = event.evidence?.initiatedBy;
    if (!document) return;
    for (let i = this.events.length - 1; i >= 0 && i > this.events.length - JOIN_SCAN; i--) {
      const carrier = this.events[i];
      if (carrier.kind !== 'request' || carrier.url !== document) continue;
      if (carrier.commandIndex !== undefined) event.commandIndex = carrier.commandIndex;
      if (carrier.runId !== undefined) {
        event.runId = carrier.runId;
        event.step = carrier.step;
      }
      return;
    }
  }

  /** A report that arrived before its request crossed, where one is waiting. */
  private takeInitiator(
    method: string, url: string, startedAt: number
  ): { root: InitiatorRoot; document?: string } | undefined {
    const key = `${method.toUpperCase()} ${url}`;
    // Closest in time wins, and `input` breaks a tie. Preferring any `input`
    // report inside the window instead would hand a poll the click's report
    // when both hit one endpoint within it, and the poll would then take the
    // gesture's command with it.
    let best = -1;
    let bestGap = Infinity;
    for (let i = 0; i < this.reportedInitiators.length; i++) {
      const held = this.reportedInitiators[i];
      if (held.key !== key) continue;
      const gap = Math.abs(held.at - startedAt);
      if (gap > JOIN_WINDOW_MS) continue;
      const closer = gap < bestGap;
      const tied = gap === bestGap && held.root === 'input';
      if (closer || tied) { best = i; bestGap = gap; }
    }
    if (best === -1) return undefined;
    const [held] = this.reportedInitiators.splice(best, 1);
    // Any other report still held for this same request describes a request
    // that has now been accounted for, so it would only be taken by a later
    // request to the same URL that nothing reported.
    this.reportedInitiators = this.reportedInitiators.filter(
      other => !(other.key === key && Math.abs(other.at - startedAt) <= JOIN_WINDOW_MS));
    return { root: held.root, document: held.document };
  }

  /** Requests whose initiator is joined but whose bytes have not crossed yet. */
  private reportedInitiators: Array<
    { key: string; root: InitiatorRoot; at: number; document?: string }
  > = [];

  /** One live socket's allowance queue, reachable from outside its closure. */
  private ledgers = new Set<SocketLedger>();
  /**
   * The page's own socket numbering, matched to this proxy's sockets.
   *
   * A document numbers its sockets as it opens them and the proxy numbers the
   * connections it carries, so the two agree on order and not on identity.
   * The first report that fits exactly one socket fixes the pairing.
   */
  private boundSockets = new Map<number, SocketLedger>();

  /**
   * Record what the page reports started one socket send.
   *
   * The report crosses a CDP session and the bytes cross the wire, so which
   * arrives first is not fixed. A report ahead of its frame waits on the
   * socket's ledger for the frame to claim it. A report behind its frame
   * stamps the frame that already crossed, and where a timer opened that send
   * it also withdraws the allowance the send opened - while no arrival has
   * consumed it, which on a socket answering in milliseconds is most of them.
   */
  noteSend(
    url: string, socket: number, sequence: number, size: number,
    root: 'input' | 'timer' | 'script', at: number
  ): void {
    const ledger = ledgerFor(this.ledgers, this.boundSockets, url, socket, sequence, size);
    if (!ledger) return;
    const frame = ledger.sent.find(s => s.sequence === sequence);
    if (frame?.event) {
      if (frame.size !== size && size >= 0) return;
      if (at - frame.event.at > JOIN_SEND_MS) return;
      (frame.event.evidence ??= {}).initiator = root;
      this.attributeFromPage(frame.event);
      // A report usually lands after its own frame, so this is the path a
      // timer send normally takes: the allowance it opened is taken back here
      // rather than never opened, and counted the same either way.
      if (root === 'timer') {
        withdrawAllowance(ledger, size);
        ledger.profile.sentUnprompted += 1;
      }
      return;
    }
    ledger.reportedSends.set(sequence, { size, root, at });
    if (ledger.reportedSends.size > MAX_REPORTED_SENDS) {
      const oldest = ledger.reportedSends.keys().next().value;
      if (oldest !== undefined) ledger.reportedSends.delete(oldest);
    }
  }

  /**
   * Drop what has been recorded, and keep what has been decided.
   *
   * The events are a reading of what has happened so far; the pins, the shape
   * verdicts and the allow list are decisions about what happens next. Clearing
   * the reading leaves every decision armed, so a run started after a clear is
   * scoped and answered exactly as it was before.
   *
   * Eviction is marked through the highest command cleared, so `measurable`
   * still reports the truth: a step whose events were dropped here is left out
   * of a comparison rather than compared against nothing.
   */
  clear(): void {
    for (const gone of this.events) {
      const owner = causeOf(gone);
      if (owner?.kind === 'command') {
        this.evictedThrough = Math.max(this.evictedThrough, owner.index);
      }
    }
    this.events = [];
    this.bodies.clear();
    // The count and the per-host list are one reading in two shapes. Clearing
    // one and not the other reports a refusal total with nothing behind it.
    this.refusedHosts.clear();
    this.blockedCount = 0;
    this.refusedWriteCount = 0;
  }

  /** Whether this command's events are still held, or have been dropped. */
  measurable(commandIndex: number): boolean {
    return commandIndex > this.evictedThrough;
  }

  /** Every shape a person has ruled on, for storing with a recording. */
  shapeRules(): ShapeRules {
    return { ...this.rules };
  }

  /** What crossed under one live command, oldest first. */
  eventsForCommand(index: number): ProxyEvent[] {
    return this.events.filter(e => {
      const owner = causeOf(e);
      return owner?.kind === 'command' && owner.index === index;
    });
  }

  /** What crossed under one step of one replay pass, oldest first. */
  eventsForStep(runId: string, step: number): ProxyEvent[] {
    return this.events.filter(e => {
      const owner = causeOf(e);
      return owner?.kind === 'replay' && owner.runId === runId && owner.step === step;
    });
  }

  /** What the proxy saw in a window, oldest first. */
  eventsIn(since?: number, until?: number): ProxyEvent[] {
    return this.events.filter(e =>
      (since === undefined || e.at >= since) && (until === undefined || e.at < until));
  }

  /**
   * Resolve once nothing has crossed for `quietMs`, or `capMs` has passed.
   *
   * Holds a returning command's cursor over traffic that starts after it
   * returned, so that traffic is credited to it by position. The cases this
   * covers are the ones the page cannot report on - a worker's first line, a
   * load that happened before the session attached, a frozen prototype - since
   * a reported root already accounts for the rest without any wait.
   *
   * `lastEventAt` moves for anything recorded, so an app that chatters never
   * goes quiet and the cap ends the wait instead. The boundary is then as wide
   * as the cap rather than as tight as the app allows.
   */
  async settle(quietMs: number, capMs: number): Promise<void> {
    if (quietMs <= 0) return;
    const deadline = Date.now() + capMs;
    while (Date.now() < deadline) {
      const quietFor = Date.now() - this.lastEventAt;
      if (quietFor >= quietMs) return;
      const wait = Math.min(quietMs - quietFor, deadline - Date.now());
      await new Promise(resolve => setTimeout(resolve, Math.max(wait, 10)));
    }
  }

  /**
   * Sockets open right now.
   *
   * Distinct from the profile count, which holds every socket this session
   * opened: a page that reconnects ten times has ten profiles and one live
   * connection, and only the second says what the app is holding open.
   */
  openSockets(): number {
    return this.ledgers.size;
  }

  /** Each socket this proxy carried, with what it did and the shape that makes. */
  socketShapes(): Array<SocketProfile & { shape: SocketShape }> {
    return this.profiles.map(profile => ({ ...profile, shape: shapeOf(profile) }));
  }

  /** The kept body for one event, where there is one. */
  bodyOf(id: string): string | undefined {
    return this.bodies.get(id);
  }

  private record(
    event: Omit<ProxyEvent, 'id'>,
    body?: string,
    cursor: ProxyCursor | undefined = this.cursor
  ): ProxyEvent | undefined {
    try {
      if (this.isQuiet(new URL(event.url).host)) return undefined;
    } catch { /* not a URL to judge by; record it */ }
    if (event.kind === 'request' && event.evidence?.initiator === undefined) {
      const reported = this.takeInitiator(
        event.method ?? 'GET', event.url, event.startedAt ?? event.at);
      if (reported) {
        const evidence = (event.evidence ??= {});
        evidence.initiator = reported.root;
        if (reported.document) evidence.initiatedBy = reported.document;
      }
    }
    // A shape ruled background does not hold the boundary open: it arrives on
    // the app's own schedule, and counting it as activity means a settle waits
    // the full cap on every call against an app with a heartbeat.
    const ruledShape = event.evidence?.shape ? this.rules[event.evidence.shape] : undefined;
    if (ruledShape !== 'background' && ruledShape !== 'unknown') this.lastEventAt = Date.now();
    const stored: ProxyEvent = {
      id: `ev-${++this.eventSeq}`,
      ...event,
      ...(cursor?.kind === 'command' && { commandIndex: cursor.index }),
      ...(cursor?.kind === 'replay' && { runId: cursor.runId, step: cursor.step }),
    };
    this.attributeFromPage(stored);
    this.events.push(stored);
    if (body !== undefined) this.bodies.set(stored.id, body);
    if (this.events.length > MAX_EVENTS) {
      for (const gone of this.events.splice(0, this.events.length - MAX_EVENTS)) {
        this.bodies.delete(gone.id);
        const owner = causeOf(gone);
        if (owner?.kind === 'command') {
          this.evictedThrough = Math.max(this.evictedThrough, owner.index);
        }
      }
    }
    return stored;
  }

  /** Every frame that crosses a proxied socket, both directions. */
  onFrame(handler: (frame: SocketFrame) => void): () => void {
    this.frameHandlers.add(handler);
    return () => this.frameHandlers.delete(handler);
  }

  private announce(frame: SocketFrame): void {
    for (const handler of this.frameHandlers) {
      try { handler(frame); } catch { /* a reader must not break the pipe */ }
    }
  }

  pin(spec: Omit<Pin, 'id' | 'hits' | 'status' | 'headers'> & {
    status?: number;
    headers?: Record<string, string>;
  }): Pin {
    const pin: Pin = {
      id: `pin-${++this.pinSeq}`,
      urlIncludes: spec.urlIncludes,
      ...(spec.method ? { method: spec.method.toUpperCase() } : {}),
      ...(spec.step !== undefined ? { step: spec.step } : {}),
      status: spec.status ?? 200,
      headers: spec.headers ?? { 'content-type': 'application/json' },
      body: spec.body,
      hits: 0,
    };
    this.pins.set(pin.id, pin);
    return pin;
  }

  unpin(id: string): boolean {
    return this.pins.delete(id) || this.framePins.delete(id);
  }

  /** Hold a frame: replace what it carries, or drop it so nothing arrives. */
  pinFrame(spec: Omit<FramePin, 'id' | 'hits' | 'field'>): FramePin {
    const field = fieldOf(spec.textIncludes);
    const pin: FramePin = {
      id: `frame-${++this.pinSeq}`, hits: 0, ...spec, ...(field ? { field } : {}),
    };
    this.framePins.set(pin.id, pin);
    return pin;
  }

  listFramePins(): FramePin[] {
    return [...this.framePins.values()];
  }

  /**
   * The pin that matches this frame most narrowly.
   *
   * Every pin whose constraints hold is a candidate, and one frame can satisfy
   * several: `"tag":"ready"` is carried by every payload that also carries
   * `"tag":"ready-retry"`. Taken in insertion order, which pin answers is the
   * order the pins were armed in, so arming a narrower rule second leaves the
   * broader one answering and the narrower one reading as never fired.
   *
   * Narrowness is counted as the constraints a pin carries, then the length of
   * the text it matches on: a pin bound to one socket and one direction is
   * narrower than one bound to neither, and a longer payload substring is
   * carried by fewer payloads than a shorter one it contains. A field counts
   * as a constraint on a frame that parses, where it is what decided the
   * match; on a frame that does not parse every pin is a substring pin and
   * the field counts nothing.
   */
  private matchFramePin(
    url: string, direction: SocketFrame['direction'], text: string | undefined,
  ): FramePin | undefined {
    if (text === undefined) return undefined;
    let held: FramePin | undefined;
    let narrowest = -1;
    // Parsed once, on the first pin that compares a field, and never for a
    // pin set holding none.
    let object: Record<string, unknown> | undefined | null = null;
    for (const pin of this.framePins.values()) {
      if (pin.urlIncludes && !url.includes(pin.urlIncludes)) continue;
      if (pin.direction && pin.direction !== direction) continue;
      if (pin.step !== undefined && !this.underStep(pin.step)) continue;
      if (pin.field && object === null) object = objectOf(text);
      const byField = pin.field !== undefined && object !== undefined && object !== null;
      const matched = byField ? carries(object!, pin.field!) : text.includes(pin.textIncludes);
      if (!matched) continue;
      const narrowness = (pin.urlIncludes ? 1 : 0) + (pin.direction ? 1 : 0)
        + (pin.step !== undefined ? 1 : 0) + (byField ? 1 : 0);
      if (narrowness < narrowest) continue;
      if (narrowness === narrowest
        && held !== undefined
        && pin.textIncludes.length <= held.textIncludes.length) continue;
      held = pin;
      narrowest = narrowness;
    }
    return held;
  }

  listPins(): Pin[] {
    return [...this.pins.values()];
  }

  /**
   * Whether a replay step is the one in flight.
   *
   * Read off the cursor as the request arrives. A request starting after its
   * step released carries the next step or none, so a step-bound pin answers
   * only what crosses while its step is marked; the settle window is what
   * keeps a step marked over its tail.
   */
  private underStep(step: number): boolean {
    return this.cursor?.kind === 'replay' && this.cursor.step === step;
  }

  /**
   * The pin that matches this request most narrowly.
   *
   * `/draft` is carried by every URL that carries `/draft/attachments`, so one
   * request satisfies both pins. Taken in insertion order, which pin answers
   * is the order they were armed in. A pin naming a method holds against one
   * verb where a pin naming none holds against every verb on that path, so it
   * is counted narrower; a longer path substring is carried by fewer URLs than
   * a shorter one it contains.
   */
  private matchPin(url: string, method: string): Pin | undefined {
    let held: Pin | undefined;
    let narrowest = -1;
    for (const pin of this.pins.values()) {
      if (pin.method && pin.method !== method.toUpperCase()) continue;
      if (pin.step !== undefined && !this.underStep(pin.step)) continue;
      if (!url.includes(pin.urlIncludes)) continue;
      const narrowness = (pin.method ? 1 : 0) + (pin.step !== undefined ? 1 : 0);
      if (narrowness < narrowest) continue;
      if (narrowness === narrowest
        && held !== undefined
        && pin.urlIncludes.length <= held.urlIncludes.length) continue;
      held = pin;
      narrowest = narrowness;
    }
    return held;
  }

  /** Answer from a pin, or forward and pipe the bytes back untouched. */
  private handle(secure: boolean, req: IncomingMessage, res: ServerResponse): void {
    // A request straight to the proxy carries an absolute URI; one arriving
    // through a CONNECT tunnel carries only a path, and its host is a header.
    const host = req.headers.host ?? '';
    const path = req.url ?? '/';
    const url = /^https?:\/\//i.test(path) ? path : `${secure ? 'https' : 'http'}://${host}${path}`;
    // Taken as the request arrives, not when the response completes: an
    // exchange answered after the next command began belongs to the command
    // that issued it.
    const issuedUnder = this.cursor;
    const requestedAt = Date.now();
    if (this.isBrowserService(host, path)) {
      // Refused rather than answered: a background service reads a failure as
      // the network being away and backs off, where an empty success can send
      // it round again.
      this.noteRefusal(host);
      res.destroy();
      return;
    }

    const pin = this.matchPin(url, req.method ?? 'GET');

    if (pin) {
      pin.hits += 1;
      res.writeHead(pin.status, { ...pin.headers, 'content-length': Buffer.byteLength(pin.body) });
      res.end(pin.body);
      this.record({
        at: Date.now(), kind: 'request', direction: 'out', url,
        method: req.method ?? 'GET', status: pin.status, evidence: { protocolPaired: true },
        size: Buffer.byteLength(pin.body), preview: pin.body.slice(0, PREVIEW_CHARS),
        durationMs: 0, startedAt: requestedAt,
        ...(pin.headers['content-type'] ? { contentType: pin.headers['content-type'].split(';')[0] } : {}),
        heldAs: 'replaced',
      }, pin.body, issuedUnder);
      return;
    }

    const method = (req.method ?? 'GET').toUpperCase();
    // The bench is served through this proxy too, and its own control plane
    // is written to by POST. Refused with everything else, the request that
    // turns this setting off is itself refused, and the only way back is a
    // call made from outside the browser.
    if (this.refuseWrites && !SAFE_METHODS.has(method) && !this.isQuiet(host)) {
      // Answered with a status rather than destroyed as a browser service is:
      // an app reads a destroyed socket as an outage and retries, where a 403
      // with a body reaches its own error path and the console.
      this.refusedWriteCount += 1;
      const body = JSON.stringify({
        error: `refused by devharness: no rule answers ${method} ${url} and unmatched writes are refused`,
      });
      res.writeHead(403, {
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(body),
        'x-devharness-refused': 'unmatched-write',
      });
      res.end(body);
      this.record({
        at: Date.now(), kind: 'request', direction: 'out', url,
        method, status: 403, evidence: { protocolPaired: true },
        size: Buffer.byteLength(body), preview: body.slice(0, PREVIEW_CHARS),
        durationMs: 0, startedAt: requestedAt, contentType: 'application/json',
        heldAs: 'refused',
      }, body, issuedUnder);
      return;
    }

    let target: URL;
    try { target = new URL(url); } catch { res.writeHead(400).end('bad request line'); return; }

    const send = secure ? httpsRequest : httpRequest;
    const upstream = send({
      protocol: target.protocol,
      host: target.hostname,
      port: target.port || (secure ? 443 : 80),
      method: req.method,
      path: target.pathname + target.search,
      headers: req.headers,
      ...(secure ? { rejectUnauthorized: false } : {}),
    }, (answer) => {
      res.writeHead(answer.statusCode ?? 502, answer.headers);
      const startedAt = Date.now();
      const contentType = typeof answer.headers['content-type'] === 'string'
        ? (answer.headers['content-type'] as string).split(';')[0]
        : undefined;
      // Tapped rather than buffered: the bytes still pipe through untouched and
      // a copy is kept up to the cap, so an exchange can become a held value
      // later without the proxy having to parse anything now.
      let kept = '';
      let size = 0;

      // A stream's response never ends while it is doing its job. Recorded at
      // the headers rather than at the end, so an event source or a long poll
      // is on the record for as long as it is open instead of appearing only
      // once it closes - and the size and duration are filled in as it runs.
      const streaming = contentType === 'text/event-stream'
        || answer.headers['transfer-encoding'] === 'chunked';
      const opened = streaming
        ? this.record({
          at: Date.now(), kind: 'request', direction: 'out', url,
          method: req.method ?? 'GET', status: answer.statusCode ?? 0,
          evidence: { protocolPaired: true },
          size: 0, durationMs: 0, startedAt: requestedAt, open: true,
          ...(contentType ? { contentType } : {}),
        }, '', issuedUnder)
        : undefined;

      // Each message of an event stream is a push the server made, which is
      // the same fact a socket frame carries. Split on the blank line the
      // protocol ends a message with, so a message spanning two chunks is one
      // event rather than two halves.
      let pending = '';
      const takeMessages = (chunk: string) => {
        pending += chunk;
        let cut = pending.indexOf('\n\n');
        while (cut !== -1) {
          const block = pending.slice(0, cut);
          pending = pending.slice(cut + 2);
          const data = block.split('\n')
            .filter(line => line.startsWith('data:'))
            .map(line => line.slice(5).trim())
            .join('\n');
          if (data) {
            this.record({
              at: Date.now(), kind: 'frame', direction: 'in', url,
              size: Buffer.byteLength(data),
              evidence: { shape: payloadShape(data, false, Buffer.byteLength(data)) },
              preview: data.slice(0, PREVIEW_CHARS),
            }, data);
          }
          cut = pending.indexOf('\n\n');
        }
        // A stream that never blank-lines would grow this forever.
        if (pending.length > BODY_CAP) pending = pending.slice(-BODY_CAP);
      };

      answer.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (kept.length < BODY_CAP) kept += chunk.toString('utf8', 0, BODY_CAP - kept.length);
        if (opened) {
          opened.size = size;
          opened.durationMs = Date.now() - startedAt;
          if (contentType === 'text/event-stream') takeMessages(chunk.toString('utf8'));
        }
      });
      answer.on('end', () => {
        if (opened) {
          opened.size = size;
          opened.durationMs = Date.now() - startedAt;
          opened.preview = kept.slice(0, PREVIEW_CHARS);
          opened.open = undefined;
          return;
        }
        this.record({
          at: Date.now(), kind: 'request', direction: 'out', url,
          method: req.method ?? 'GET', status: answer.statusCode ?? 0,
          evidence: { protocolPaired: true },
          size, preview: kept.slice(0, PREVIEW_CHARS),
          durationMs: Date.now() - startedAt, startedAt: requestedAt,
          ...(contentType ? { contentType } : {}),
        }, kept, issuedUnder);
      });
      answer.pipe(res);
    });
    upstream.on('error', () => { if (!res.headersSent) res.writeHead(502); res.end(); });
    req.pipe(upstream);
  }

  /** Terminate the page's socket, open our own upstream, forward with a hook. */
  private handleUpgrade(secure: boolean, req: IncomingMessage, socket: Socket, head: Buffer): void {
    const host = req.headers.host ?? '';
    const url = `${secure ? 'wss' : 'ws'}://${host}${req.url}`;

    this.upgrades.handleUpgrade(req, socket, head, (client) => {
      client.on('error', () => { /* handled by the close pairing below */ });
      const requested = (req.headers['sec-websocket-protocol'] ?? '')
        .split(',').map(p => p.trim()).filter(Boolean);
      const upstream = new WebSocket(url, requested, {
        rejectUnauthorized: false,
        headers: { ...(req.headers.origin ? { origin: req.headers.origin } : {}) },
      });
      const pending: Array<[any, boolean]> = [];

      const profile: SocketProfile = {
        url, sent: 0, received: 0, allowancesRefused: 0, sentUnprompted: 0, paired: 0,
        receivedLate: 0, receivedUnprompted: 0, longestRun: 0,
      };
      this.profiles.push(profile);
      if (this.profiles.length > MAX_PROFILES) this.profiles.splice(0, this.profiles.length - MAX_PROFILES);
      let runSinceSend = 0;
      /**
       * Sends with no arrival accounted to them yet, oldest first.
       *
       * A queue rather than a count: two sends outstanding under different
       * commands answer in order, and each answer carries the command of the
       * send it settles rather than of the most recent one.
       */
      const allowances: SocketLedger['allowances'] = [];
      /** Ids sent on this socket, with what was in flight when each went out. */
      const sentIds = new Map<string, { cursor: ProxyCursor | undefined; at: number }>();
      // Held on the instance as well as in this closure, so a send the page
      // reports after its bytes crossed can still reach the allowance that
      // send opened. Dropped when the socket closes.
      const ledger: SocketLedger = {
        url, allowances, reportedSends: new Map(), sent: [], sentCount: 0, profile,
      };
      this.ledgers.add(ledger);
      /**
       * The subprotocol names what an `id` means on this socket.
       *
       * With one, the pairing is the protocol's own and holds for as long as
       * the protocol says. Without one, `id` is a field name that an entity
       * can carry as readily as a request, so a bare match is treated as a
       * guess: it expires like an allowance and never makes the socket
       * authoritative.
       */
      const gated = requested.length > 0;
      /**
       * An arrival has matched a sent id on this socket.
       *
       * Once it has, the ids are authoritative and the allowance is not
       * consulted: a socket sending faster than it receives always holds a
       * fresh allowance, so falling back to one would credit every push to
       * whichever send happened to be outstanding.
       */
      let paired = false;

      const forward = (from: WebSocket, to: WebSocket, direction: SocketFrame['direction']) => {
        from.on('message', (data: any, binary: boolean) => {
          const buf = Buffer.isBuffer(data) ? data : Buffer.from(String(data));
          const text = binary ? undefined : buf.toString('utf8');
          const held = this.matchFramePin(url, direction, text);
          if (held) held.hits += 1;

          const heldAs = held
            ? (held.replaceWith === undefined ? 'dropped' as const : 'replaced' as const)
            : undefined;
          const id = pairingId(text);
          // Measurements, not a verdict: the level is read off these later.
          const evidence: EventEvidence = { shape: payloadShape(text, binary, buf.length) };

          if (direction === 'sent') {
            profile.sent += 1;
            runSinceSend = 0;
            if (id !== undefined) {
              sentIds.set(id, { cursor: this.cursor, at: Date.now() });
              if (sentIds.size > MAX_PENDING_IDS) {
                sentIds.delete(sentIds.keys().next().value as string);
              }
            }
            // The proxy's own count for this socket, which the page's send
            // sequence is matched against.
            const sequence = ledger.sentCount + 1;
            // What the page said started this send, where it said anything.
            const reported = takeReportedSend(ledger, sequence, buf.length);
            if (reported) evidence.initiator = reported;
            // A timer opened this send, so the app's own schedule did, and the
            // answer to it answers no command. Opening an allowance would let
            // the next arrival read as an answer to whatever was in flight,
            // which is the laundering a heartbeat does on a busy socket.
            if (reported === 'timer') {
              profile.sentUnprompted += 1;
            } else if (allowances.length < MAX_ALLOWANCES) {
              // Refused rather than evicting the oldest: the oldest is the one
              // the next answer settles, so dropping it slides every later
              // answer onto a send that is not its own for the rest of a burst.
              allowances.push({ cursor: this.cursor, at: Date.now(), size: buf.length });
            } else {
              profile.allowancesRefused += 1;
            }
          } else {
            profile.received += 1;
            runSinceSend += 1;
            if (runSinceSend > profile.longestRun) profile.longestRun = runSinceSend;
            // An id the client sent pairs this arrival to that send, whatever
            // order the answers come back in and however busy the socket is.
            // Kept rather than consumed: one subscribe is answered by many
            // frames carrying its id, and each is caused by that send.
            const match = id !== undefined ? sentIds.get(id) : undefined;
            const fresh = match !== undefined
              && (gated || Date.now() - match.at <= ALLOWANCE_MS);
            if (match && fresh) {
              // Only a protocol-named id makes this socket authoritative. One
              // bare collision - an entity id matching an old request id -
              // would otherwise zero every genuine allowance pairing after it.
              if (gated) paired = true;
              profile.paired += 1;
              evidence.pairing = { how: 'id', sentUnder: match.cursor, afterMs: Date.now() - match.at };
            } else if (paired) {
              // Ids are authoritative on this socket and this frame matched
              // none, so the allowance is not consulted: a socket sending
              // faster than it receives always holds a fresh one, and falling
              // back would credit every push to whichever send was open.
              profile.receivedUnprompted += 1;
              evidence.socketPairs = true;
            } else {
              const now = Date.now();
              let aged = 0;
              while (allowances.length > 0 && now - allowances[0].at > ALLOWANCE_MS) {
                allowances.shift();
                aged += 1;
              }
              const settles = allowances.shift();
              if (settles) {
                evidence.pairing = {
                  how: 'allowance', sentUnder: settles.cursor, afterMs: now - settles.at,
                };
              } else if (aged > 0) {
                profile.receivedLate += 1;
                evidence.agedOut = aged;
              } else {
                profile.receivedUnprompted += 1;
              }
            }
            evidence.socket = {
              sent: profile.sent, received: profile.received,
              paired: profile.paired, unprompted: profile.receivedUnprompted,
            };
          }

          this.announce({
            at: Date.now(), url, direction, binary, size: buf.length,
            ...(text !== undefined ? { text } : {}),
            ...(heldAs ? { heldAs } : {}),
          });
          const recorded = this.record({
            at: Date.now(), kind: 'frame', direction: direction === 'sent' ? 'out' : 'in',
            url, binary, size: buf.length, evidence,
            ...(text !== undefined ? { preview: text.slice(0, PREVIEW_CHARS) } : {}),
            ...(heldAs ? { heldAs } : {}),
          }, text);
          // Held so a report arriving after this frame reaches the frame it
          // names rather than whichever one shares its length.
          if (direction === 'sent') {
            ledger.sentCount += 1;
            ledger.sent.push({
              sequence: ledger.sentCount, size: buf.length, event: recorded,
            });
            if (ledger.sent.length > MAX_REPORTED_SENDS) {
              ledger.sent.splice(0, ledger.sent.length - MAX_REPORTED_SENDS);
            }
          }

          if (held && held.replaceWith === undefined) return;
          const payload = held?.replaceWith !== undefined ? held.replaceWith : data;
          const asBinary = held?.replaceWith !== undefined ? false : binary;
          if (to.readyState === WebSocket.OPEN) to.send(payload, { binary: asBinary });
          else if (to === upstream) pending.push([payload, asBinary]);
        });
      };

      forward(client, upstream, 'sent');
      forward(upstream, client, 'received');

      upstream.on('open', () => {
        for (const [data, binary] of pending.splice(0)) upstream.send(data, { binary });
      });
      const close = (a: WebSocket, b: WebSocket) => a.on('close', (code, reason) => {
        // The ledger exists for a report that may still be in flight; a closed
        // socket answers nothing further, so holding it would grow the set for
        // the session's life.
        this.ledgers.delete(ledger);
        for (const [number, held] of this.boundSockets) {
          if (held === ledger) this.boundSockets.delete(number);
        }
        try { b.close(sendableCloseCode(code), reason); } catch { /* already gone */ }
      });
      close(client, upstream);
      close(upstream, client);
      upstream.on('error', () => { try { client.close(1011); } catch { /* already gone */ } });
      client.on('error', () => { try { upstream.close(1011); } catch { /* already gone */ } });
    });
  }

  async start(): Promise<{ port: number; spkiFingerprint: string; chromeArgs: string[] }> {
    this.certificate = mintProxyCertificate();
    this.inner = createHttpsServer(
      { cert: this.certificate.cert, key: this.certificate.key, ALPNProtocols: ['http/1.1'] },
      (req, res) => this.handle(true, req, res));
    this.inner.on('upgrade', (req, socket, head) => this.handleUpgrade(true, req, socket as Socket, head));

    this.front.on('request', (req, res) => this.handle(false, req, res));
    this.front.on('upgrade', (req, socket, head) => this.handleUpgrade(false, req, socket as Socket, head));
    this.innerPlain = createHttpServer((req, res) => this.handle(false, req, res));
    this.innerPlain.on('upgrade', (req, socket, head) => this.handleUpgrade(false, req, socket as Socket, head));

    // Chrome tunnels every WebSocket through CONNECT, ws:// included, so a
    // tunnel is not TLS by virtue of being a tunnel. The first byte says which
    // it is: a TLS record starts 0x16, an HTTP request line starts with a
    // letter. Routing every tunnel to the TLS server fails the handshake on a
    // plaintext one and the page sees its socket close before any reply.
    this.front.on('connect', (req, socket: Socket, head: Buffer) => {
      // A peer resetting a tunnel is ordinary. Unhandled, its error event ends
      // the process and takes every other connection with it.
      socket.on('error', () => socket.destroy());
      if (this.isBrowserService(req.url ?? '')) {
        this.noteRefusal(req.url ?? '(unknown)');
        socket.destroy();
        return;
      }
      socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      const route = (first: Buffer) => {
        socket.unshift(first);
        (first[0] === 0x16 ? this.inner : this.innerPlain).emit('connection', socket);
      };
      if (head?.length) { route(head); return; }
      // Read one byte in paused mode and put it back. A 'data' listener would
      // switch the socket to flowing and the handshake would stream past
      // before the TLS server had attached, which reads as a hang rather than
      // an error.
      const peek = () => {
        const first = socket.read(1) as Buffer | null;
        if (first === null) { socket.once('readable', peek); return; }
        route(first);
      };
      peek();
    });

    // Every stream here belongs to a peer that may vanish: a reset, a half-open
    // socket, a request line Node rejects. Each one is a normal event for a
    // proxy and none of them may reach the default error handler.
    for (const server of [this.front, this.inner, this.innerPlain]) {
      server.on('clientError', (_err, socket) => (socket as Socket).destroy());
      server.on('connection', (socket) => socket.on('error', () => socket.destroy()));
    }
    this.inner.on('tlsClientError', (_err, socket) => (socket as any).destroy());
    this.front.on('error', () => { /* reported through start()'s rejection */ });

    await new Promise<void>((resolve) => this.front.listen(0, '127.0.0.1', resolve));
    this.port = (this.front.address() as any).port;

    return {
      port: this.port,
      spkiFingerprint: this.certificate.spkiFingerprint,
      chromeArgs: [
        `--proxy-server=http://127.0.0.1:${this.port}`,
        // Chrome bypasses proxies for loopback by default, which would take
        // every locally served app straight past this with no error.
        '--proxy-bypass-list=<-loopback>',
        `--ignore-certificate-errors-spki-list=${this.certificate.spkiFingerprint}`,
        // QUIC does not traverse an HTTP proxy; without this, traffic to a
        // site offering HTTP/3 simply goes around.
        '--disable-quic',
        // Chrome's own traffic goes through the proxy too, and there is a great
        // deal of it: variations, update checks, optimization-guide model
        // downloads, extension fetches. Measured on one launch, 29 of 35
        // events were Chrome talking to Google and 6 were the app. Left on,
        // the count between two steps says nothing about the app.
        '--disable-background-networking',
        '--disable-component-update',
        '--disable-domain-reliability',
        '--disable-client-side-phishing-detection',
        '--disable-sync',
        '--metrics-recording-only',
        '--no-pings',
      ],
    };
  }

  async stop(): Promise<void> {
    this.upgrades.close();
    await new Promise<void>((resolve) => this.front.close(() => resolve()));
  }
}
