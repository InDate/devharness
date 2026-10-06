/**
 * The bench's toggle for the person's input in the app: off stops the watch
 * every driven page carries, and on starts it again. The watch itself, and
 * what it records, is `person-watch.ts`.
 */
import { allowPersonWatch, unwatchPersonInput, watchPersonInput } from '../person-watch.js';
import { sessions } from './session.js';

export async function setPersonInput(connection: string, on: boolean): Promise<void> {
  const session = sessions.get(connection);
  if (!session) return;
  if (!on) {
    await unwatchPersonInput(connection, true);
    return;
  }
  allowPersonWatch(connection);
  await watchPersonInput(connection, session.page);
}
