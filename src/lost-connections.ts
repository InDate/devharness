import { createErrorResponse } from './messages.js';

/**
 * Connections closed because the Chrome they ran in exited, by name.
 *
 * A call naming one finds no connection, and an auto-launch then opens the
 * name again in whatever Chrome stands on the port: a tab there shares that
 * Chrome's proxy and its scope, so a page the old connection reached through
 * its own proxy is refused under another's. Kept here, the loss is what such a
 * call answers with; a connection created again under the name clears it.
 */
export interface LostConnection {
  at: number;
  port: number;
  /** Why Chrome exited, as the launcher recorded it: `external` where something outside devharness closed it. */
  reason: string;
  /** The connection crossed a proxy of its own, which a relaunch has to ask for again. */
  proxied: boolean;
}

const lost = new Map<string, LostConnection>();

export function noteLostConnection(name: string, loss: LostConnection): void {
  lost.set(name, loss);
}

export function lostConnection(name: string): LostConnection | undefined {
  return lost.get(name);
}

export function forgetLostConnection(name: string): void {
  lost.delete(name);
}

/** The refusal a call naming a lost connection answers with, naming the launch that reopens it as it was. */
export function lostConnectionResponse(name: string, loss: LostConnection, url?: string) {
  const relaunch = `connection({ action: 'launch', connection: '${name}'${loss.proxied ? ', proxy: true' : ''}${url ? `, url: '${url}'` : ''} })`;
  return createErrorResponse('CONNECTION_LOST', {
    reference: name, port: String(loss.port), at: new Date(loss.at).toLocaleTimeString(),
    external: loss.reason === 'external' || undefined, relaunch,
  });
}
