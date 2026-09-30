/**
 * Config Tools
 * MCP tools for managing devharness configuration
 */

import { z } from 'zod';
import { createTool } from '../validation-helpers.js';
import { configManager } from '../config.js';
import { createSuccessResponse, createErrorResponse } from '../messages.js';
import { requestSelfRestart } from '../self-restart.js';
import { InvalidProfileNameError, ProfileInUseError } from '../chrome-launcher.js';

const configSchema = z.object({
  action: z.enum(['status', 'useLocal', 'useGlobal', 'reset', 'backup', 'cloneFromGlobal', 'show', 'listTools', 'reload', 'restart', 'listProfiles', 'resetProfile'])
    .describe('Config action: status (show config location info), useLocal (switch to project config), useGlobal (switch to global config), reset (reset to defaults), backup (backup current config), cloneFromGlobal (copy global to local), show (display current config), listTools (list all toggleable tools with status and dependencies), reload (re-read config.json from disk now - also happens automatically on file edits), restart (restart devharness itself if stuck or broken), listProfiles (list named persistent Chrome profiles), resetProfile (wipe and recreate the named persistent Chrome profile given in `profile`)'),
  seedFromGlobal: z.boolean().optional()
    .describe('For useLocal action: if true (default), seeds new local config from global if it exists'),
  path: z.string().optional()
    .describe('useLocal: explicit project dir to use as "local" (overrides server cwd)'),
  profile: z.string().optional()
    .describe('resetProfile: name of the persistent Chrome profile (as given to connection launch as profile) to wipe and recreate empty. Refused while a Chrome launched by devharness still holds that profile - kill it first.'),
}).strict();

type ConfigArgs = z.infer<typeof configSchema>;

/** Subset of ChromeLauncher the config tool needs for profile management. */
export interface ProfileStore {
  getPersistentProfileRoot(): string;
  listPersistentProfiles(): Promise<string[]>;
  resetPersistentProfile(profile: string): Promise<{ profile: string; path: string; existed: boolean }>;
}

/**
 * Which build is answering, for `config status`. Supplied by the entry point,
 * which is the only thing that knows where it was loaded from.
 */
export interface ServerIdentity {
  version: string;
  entryPath: string;
  buildMtime: string;
}

export function createConfigTools(profileStore?: ProfileStore, serverIdentity?: ServerIdentity) {
  return {
    config: createTool(
      'Manage devharness configuration. Actions: status (show where config is loaded from), useLocal (switch to project-local config), useGlobal (switch to global ~/.devharness config), reset (reset to defaults), backup (create timestamped backup), cloneFromGlobal (copy global config to local), show (display current settings), listTools (list all toggleable tools with their status and dependencies), reload (re-read config.json now; edits also hot-reload automatically within ~250ms), restart (restart devharness itself if stuck or broken), listProfiles (list named persistent Chrome profiles and where they live), resetProfile (wipe and recreate a named persistent Chrome profile, clearing its cookies/localStorage/IndexedDB)',
      configSchema,
      async (args: ConfigArgs) => {
        switch (args.action) {
          case 'status': {
            const status = configManager.getStatus();
            return createSuccessResponse('CONFIG_STATUS', {
              loadedFrom: status.loadedFrom || 'In-memory defaults (no file)',
              location: status.isLocal ? 'local (project)' : 'global (~/.devharness)',
              localPath: status.localPath,
              globalPath: status.globalPath,
              localExists: status.localExists ? 'yes' : 'no',
              globalExists: status.globalExists ? 'yes' : 'no',
              // Which build is answering. After `npm run build`, a buildMtime
              // older than the build means the running server never reloaded -
              // the rebuild signalled a supervisor that is not serving this
              // session, and everything you observe is the previous code.
              version: serverIdentity?.version,
              entryPath: serverIdentity?.entryPath,
              buildMtime: serverIdentity?.buildMtime,
              serverPid: String(process.pid),
              supervisorPid: process.ppid ? String(process.ppid) : undefined,
            });
          }

          case 'useLocal': {
            const seedFromGlobal = args.seedFromGlobal !== false; // default true
            try {
              const result = await configManager.useLocal(seedFromGlobal, args.path);
              return createSuccessResponse('CONFIG_USE_LOCAL_SUCCESS', {
                path: result.path,
                seeded: result.seeded,
              });
            } catch (error) {
              return createErrorResponse('CONFIG_USE_LOCAL_FAILED', {
                error: error instanceof Error ? error.message : String(error),
              });
            }
          }

          case 'useGlobal': {
            const result = await configManager.useGlobal();
            return createSuccessResponse('CONFIG_USE_GLOBAL_SUCCESS', {
              path: result.path,
            });
          }

          case 'reset': {
            await configManager.reset();
            return createSuccessResponse('CONFIG_RESET_SUCCESS', {});
          }

          case 'backup': {
            const result = await configManager.backup();
            if (!result) {
              return createErrorResponse('CONFIG_BACKUP_FAILED', {});
            }
            return createSuccessResponse('CONFIG_BACKUP_SUCCESS', {
              path: result.path,
            });
          }

          case 'cloneFromGlobal': {
            const result = await configManager.cloneFromGlobal();
            if ('error' in result) {
              return createErrorResponse('CONFIG_CLONE_NO_GLOBAL', {});
            }
            return createSuccessResponse('CONFIG_CLONE_SUCCESS', {
              path: result.path,
            });
          }

          case 'show': {
            const config = configManager.getConfig();
            return createSuccessResponse('CONFIG_SHOW', {
              config: JSON.stringify(config, null, 2),
            });
          }

          case 'reload': {
            const result = await configManager.reload();
            return createSuccessResponse('CONFIG_RELOAD', {
              changed: result.changed,
              path: result.path || 'in-memory defaults (no file)',
            });
          }

          case 'restart': {
            const result = await requestSelfRestart();
            if (!result.ok) {
              if (result.reason === 'not-supervised') {
                return createErrorResponse('CONFIG_RESTART_NOT_SUPERVISED', {});
              }
              if (result.reason === 'foreign-supervisor') {
                return createErrorResponse('CONFIG_RESTART_FOREIGN_SUPERVISOR', {
                  pids: (result.otherPids ?? []).join(', '),
                });
              }
              return createErrorResponse('CONFIG_RESTART_STALE_PID', {
                pid: String(result.pid),
                error: result.error ?? 'unknown error',
              });
            }
            return createSuccessResponse('CONFIG_RESTART_REQUESTED', {
              pid: String(result.pid),
            });
          }

          case 'listProfiles': {
            if (!profileStore) {
              return createErrorResponse('CONFIG_PROFILES_UNAVAILABLE', {});
            }
            const profiles = await profileStore.listPersistentProfiles();
            return createSuccessResponse('CONFIG_PROFILE_LIST', {
              root: profileStore.getPersistentProfileRoot(),
              count: profiles.length.toString(),
              profiles: profiles.length ? profiles.join(', ') : '(none yet)',
            });
          }

          case 'resetProfile': {
            if (!profileStore) {
              return createErrorResponse('CONFIG_PROFILES_UNAVAILABLE', {});
            }
            if (!args.profile) {
              return createErrorResponse('CONFIG_PROFILE_NAME_REQUIRED', {});
            }
            try {
              const result = await profileStore.resetPersistentProfile(args.profile);
              return createSuccessResponse('CONFIG_PROFILE_RESET_SUCCESS', {
                profile: result.profile,
                path: result.path,
                existed: result.existed,
              });
            } catch (error) {
              if (error instanceof InvalidProfileNameError) {
                return createErrorResponse('CHROME_PROFILE_INVALID_NAME', { profile: args.profile });
              }
              if (error instanceof ProfileInUseError) {
                return createErrorResponse('CONFIG_PROFILE_RESET_IN_USE', {
                  profile: error.profile,
                  port: error.port.toString(),
                });
              }
              return createErrorResponse('CONFIG_PROFILE_RESET_FAILED', {
                profile: args.profile,
                error: error instanceof Error ? error.message : String(error),
              });
            }
          }

          case 'listTools': {
            const tools = configManager.getToggleableTools();
            const conflicts = configManager.getDependencyConflicts();
            const toolsJson = JSON.stringify(tools, null, 2);
            if (conflicts.length > 0) {
              return createErrorResponse('TOOLS_LIST_CONFLICT', {
                toolsJson,
                conflicts,
              });
            }
            return createSuccessResponse('TOOLS_LIST', {
              toolsJson,
            });
          }

          default: {
            const _exhaustive: never = args.action;
            return createErrorResponse('UNKNOWN_ACTION', { action: args.action });
          }
        }
      }
    ),
  };
}
