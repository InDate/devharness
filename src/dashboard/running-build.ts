import { realpathSync } from 'fs';

/**
 * The build file this server process runs, symlinks resolved. Two servers of
 * one session running the same file are a resumed copy of that session; a
 * development build beside an installed one runs another file.
 */
export const RUNNING_BUILD: string = (() => {
  const entry = process.argv[1] ?? '';
  try {
    return realpathSync(entry);
  } catch {
    return entry;
  }
})();
