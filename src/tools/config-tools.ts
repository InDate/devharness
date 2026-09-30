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
import { enableDebugLogging, disableDebugLogging, isDebugEnabled, getLogFile } from '../debug-logger.js';

const configSchema = z.object({
  action: z.enum(['status', 'useLocal', 'useGlobal', 'reset', 'backup', 'cloneFromGlobal', 'show', 'listTools', 'reload', 'restart', 'listProfiles', 'resetProfile', 'setDebugLogging', 'debugLoggingStatus']),
  seedFromGlobal: z.boolean().optional()
    .describe('useLocal: seed a new local config from the global one (default true)'),
  path: z.string().optional()
    .describe('useLocal: project dir to use as local, in place of the server cwd'),
  profile: z.string().optional()
    .describe('resetProfile: the persistent Chrome profile name, as connection launch took it'),
  enabled: z.boolean().optional()
    .describe('setDebugLogging: on or off'),
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
      'devharness configuration. Actions: status (where config loads from), useLocal, useGlobal (project or ~/.devharness config), reset (to defaults), backup (timestamped), cloneFromGlobal (global to local), show, listTools (toggleable tools, status and dependencies), reload (re-read config.json; edits also reload within ~250ms), restart (devharness itself, when stuck or broken), listProfiles (persistent Chrome profiles), resetProfile (wipe one, clearing its storage), setDebugLogging, debugLoggingStatus',
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

          case 'setDebugLogging': {
            if (args.enabled === undefined) {
              return createErrorResponse('MISSING_PARAMETER', {
                action: 'setDebugLogging',
                missing: 'enabled',
                message: 'The "setDebugLogging" action requires "enabled"',
              });
            }
            if (args.enabled) {
              await enableDebugLogging();
              return createSuccessResponse('DEBUG_LOGGING_ENABLED', {
                message: `Debug logging enabled. Logs will be written to ${getLogFile()}`
              }, {
                enabled: true,
                message: `Debug logging enabled. Logs will be written to ${getLogFile()}`
              });
            }
            disableDebugLogging();
            return createSuccessResponse('DEBUG_LOGGING_DISABLED', {
              message: 'Debug logging disabled'
            }, {
              enabled: false,
              message: 'Debug logging disabled'
            });
          }

          case 'debugLoggingStatus': {
            const enabled = isDebugEnabled();
            return createSuccessResponse('DEBUG_LOGGING_STATUS', {
              status: enabled ? 'enabled' : 'disabled',
              enabled,
              logFile: getLogFile()
            }, {
              enabled,
              logFile: getLogFile()
            });
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
