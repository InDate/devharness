/**
 * Issues Tools
 * MCP tools for tracking bugs and features as Markdown files (title + body + labels + comments)
 */

import { z } from 'zod';
import { promises as fs } from 'fs';
import { join } from 'path';
import { createTool } from '../validation-helpers.js';
import { createSuccessResponse, createErrorResponse } from '../messages.js';
import type { ExecuteToolCall } from '../types.js';
import { showVerificationOverlay, showTestReadyOverlay } from '../interaction-recorder.js';
import {
  showOverlay,
  getWorkOnNoSequenceConfig,
  getTestReadyConfig,
  getVerificationConfig,
  type OverlayResult,
} from '../overlays.js';
import { requireValidReference } from '../reference-validator.js';
import {
  initializeTracker,
  addIssue,
  getIssue,
  getIssues,
  updateIssueStatus,
  updateIssueSequenceFile,
  addIssueComment,
  acknowledgeAllBugs,
  getPendingBugs,
  getIssueSequencesDir,
  generateSequenceFilename,
  completedStatusFor,
  type TrackedIssue,
  type IssueType,
  type IssueStatus,
} from '../issue-tracker.js';
import { checkUrlPort } from '../utils/port-check.js';
import {
  handlePublish, handleSync, handleImport, handleLink, handlePullSequence,
} from '../github/issue-actions.js';
import { configManager } from '../config.js';

/** GitHub actions can be switched off in config - the override path a user
 *  can reach without going through an agent. */
function isGithubEnabled(): boolean {
  try {
    return configManager.getConfig().github?.enabled !== false;
  } catch {
    return true;
  }
}
const issuesSchema = z.object({
  action: z.enum(['list', 'create', 'workOn', 'resolve', 'acknowledge', 'comment',
    'publish', 'sync', 'import', 'link', 'pullSequence'])
    .describe('Issue action: list (list all issues, or one issue in full by id), create (create new issue), workOn (start working on issue), resolve (opens an interactive browser verification flow and waits for a PERSON to click Fixed/Not Fixed - a human must physically confirm before the issue is marked fixed/implemented, so an agent cannot close an issue this way and should use `comment` to record findings instead), acknowledge (acknowledge pending bugs), comment (append a comment to an issue)'),
  id: z.number().optional()
    .describe('Issue ID (list, workOn, resolve, comment, publish, link, pullSequence). On list it returns that one issue in full and the other filters do not apply.'),
  type: z.enum(['bug', 'feature']).optional()
    .describe('Issue type (required for create, optional filter for list)'),
  status: z.enum(['pending', 'acknowledged', 'in_progress', 'fixed', 'implemented']).optional()
    .describe('Issue status (optional filter for list)'),
  title: z.string().optional()
    .describe('Short one-line issue title (required for create)'),
  body: z.string().optional()
    .describe('Markdown body: steps to reproduce, expected/actual, code blocks, etc (optional for create)'),
  labels: z.array(z.string()).optional()
    .describe('Labels to attach (create) or filter by - matches issues with ANY of the given labels (list)'),
  text: z.string().optional()
    .describe('Comment text in Markdown (required for comment action)'),
  sequenceName: z.string().optional()
    .describe('Name of existing sequence to link (for create - moves sequence to issues folder)'),
  startUrl: z.string().optional()
    .describe('Starting URL for manual issue verification (required for create when no sequenceName provided)'),
  connectionReason: z.string().optional()
    .describe('Browser connection reference (for workOn - to replay sequence)'),
  connections: z.record(z.string()).optional()
    .describe("workOn/resolve: rebind a multi-connection repro sequence's recorded references onto this session - { \"<recorded reference>\": \"<reference here>\" }"),
  keepBrowserOpen: z.boolean().optional()
    .describe('Keep browser tab open after verification (default: false, closes tab after resolve)'),
  search: z.string().optional()
    .describe('Search term to filter issues by title, body, comments, or recording name (for list)'),
  includeCompleted: z.boolean().optional()
    .describe('Include fixed/implemented issues in list (default: false, only shows active issues)'),
  includeSequence: z.boolean().optional()
    .describe('Include sequence recording for issue (default: true). When false, no sequence is created and Chrome does not open.'),
  confirm: z.boolean().optional()
    .describe('publish/sync: actually write to GitHub (default false - publish only drafts, sync only reports upstream closes). pullSequence: accept a sequence authored by another GitHub account - only after a person has read it'),
  github: z.number().int().positive().optional()
    .describe('Upstream GitHub issue number (import, link)'),
  repo: z.string().optional()
    .describe('owner/name override; default is the repo gh infers from the project directory'),
  take: z.enum(['local', 'remote']).optional()
    .describe('sync: resolve a conflict on one issue by declaring a winner'),
  fromComment: z.number().int().positive().optional()
    .describe('pullSequence: 1-based comment index to read the sequence from (default: the issue body)'),
  allowPrivilegedSteps: z.boolean().optional()
    .describe('pullSequence: allow a remote sequence that runs code, writes files, or starts processes'),
}).strict();

type IssuesArgs = z.infer<typeof issuesSchema>;

// =============================================================================
// resolve() human-verification timeout
// =============================================================================

/**
 * Upper bound on how long `resolve` will wait for a human to respond to the
 * interactive "ready to begin?" / "is this fixed?" overlays. Kept comfortably
 * under Puppeteer's default protocolTimeout (180_000ms) so that a human
 * simply walking away surfaces as our own typed ISSUES_RESOLVE_TIMEOUT error
 * instead of a raw `Runtime.callFunctionOn timed out` leaking through from
 * the underlying page.evaluate() call that waits on the overlay's Promise.
 * Exported so tests can pass a much shorter value.
 */
export const DEFAULT_RESOLVE_VERIFICATION_TIMEOUT_MS = 150_000;

/** Internal marker so the resolve handler can distinguish "human never answered" from other failures. */
class IssuesResolveTimeoutError extends Error {
  constructor(public readonly issueId: number, public readonly timeoutMs: number) {
    super(`Timed out after ${timeoutMs}ms waiting for human verification on issue #${issueId}`);
    this.name = 'IssuesResolveTimeoutError';
  }
}

/** Race a human-response promise (overlay click) against a bounded timeout. */
async function withVerificationTimeout<T>(promise: Promise<T>, timeoutMs: number, issueId: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new IssuesResolveTimeoutError(issueId, timeoutMs)), timeoutMs);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer!);
  }
}

// =============================================================================
// Helper Functions
// =============================================================================


function formatIssuesList(issues: TrackedIssue[]): string {
  if (issues.length === 0) {
    return 'No issues found.';
  }

  const lines: string[] = [];

  // Calculate column widths
  const idWidth = Math.max(2, ...issues.map(i => String(i.id).length));
  const statusWidth = Math.max(6, ...issues.map(i => i.status.length));
  const typeWidth = 7; // "feature" is longest

  // Header
  lines.push(`${'ID'.padEnd(idWidth)}  ${'STATUS'.padEnd(statusWidth)}  ${'TYPE'.padEnd(typeWidth)}  TITLE`);

  for (const issue of issues) {
    const id = String(issue.id).padEnd(idWidth);
    const status = issue.status.toUpperCase().padEnd(statusWidth);
    const type = issue.type.padEnd(typeWidth);
    const labelSuffix = issue.labels.length > 0 ? ` [${issue.labels.join(', ')}]` : '';
    // Truncate title to ~60 chars (minus label suffix) for readability
    const maxTitleLen = Math.max(10, 60 - labelSuffix.length);
    const title = issue.title.length > maxTitleLen
      ? issue.title.substring(0, maxTitleLen - 3) + '...'
      : issue.title;

    lines.push(`${id}  ${status}  ${type}  ${title}${labelSuffix}`);
  }

  return lines.join('\n');
}

function getStatusIcon(status: IssueStatus): string {
  switch (status) {
    case 'pending': return '⏳';
    case 'acknowledged': return '👀';
    case 'in_progress': return '🔧';
    case 'fixed': return '✅';
    case 'implemented': return '✅';
    default: return '•';
  }
}

/** A listing renders bodies when it holds this many issues or fewer; above it, titles only. */
const DETAIL_RENDER_LIMIT = 1;

function formatIssueDetails(issue: TrackedIssue): string {
  const typeIcon = issue.type === 'bug' ? '🐛' : '✨';
  const statusIcon = getStatusIcon(issue.status);

  const lines = [
    `${typeIcon} **Issue #${issue.id}** - ${issue.type.toUpperCase()}`,
    `**Status:** ${statusIcon} ${issue.status}`,
    `**Title:** ${issue.title}`,
  ];

  if (issue.labels.length > 0) {
    lines.push(`**Labels:** ${issue.labels.join(', ')}`);
  }

  if (issue.body) {
    lines.push('', '**Body:**', '', issue.body);
  }

  lines.push(
    '',
    `**Recording:** ${issue.recordingName || 'none'}`,
    `**Reported:** ${issue.reportedAt.toISOString()}`,
  );

  if (issue.sequenceFile) {
    lines.push(`**Sequence:** \`${issue.sequenceFile}\``);
  }

  if (issue.acknowledgedAt) {
    lines.push(`**Acknowledged:** ${issue.acknowledgedAt.toISOString()}`);
  }

  if (issue.startedAt) {
    lines.push(`**Started:** ${issue.startedAt.toISOString()}`);
  }

  if (issue.resolvedAt) {
    lines.push(`**Resolved:** ${issue.resolvedAt.toISOString()}`);
  }

  if (issue.comments.length > 0) {
    lines.push('', '**Comments:**');
    for (const c of issue.comments) {
      lines.push(`- ${c.timestamp.toISOString()}: ${c.text}`);
    }
  }

  return lines.join('\n');
}

function formatCommentTimeline(issue: TrackedIssue): string {
  if (issue.comments.length === 0) return 'No comments yet.';
  return issue.comments.map(c => `- ${c.timestamp.toISOString()}: ${c.text}`).join('\n');
}

// =============================================================================
// Tool Export
// =============================================================================

export function createIssuesTools(
  executeToolCall: ExecuteToolCall,
  getSequencePath?: (name: string) => Promise<string | null>,
  getPageForConnection?: (connectionReason: string) => Promise<any>,
  getKnownToolNames?: () => string[]
) {
  return {
    issues: createTool(
      'Track and manage bugs and features as Markdown issues (title, Markdown body, labels, comments). Actions: list (show all issues with optional filters, or one issue in full by id), create (create new issue with title/body/labels, optionally linking a sequence), workOn (start working on issue with auto-replay), resolve (HUMAN-ONLY interactive verification: opens a browser overlay and waits for a person to confirm the fix before marking fixed/implemented - agents are refused immediately, use `comment` instead), acknowledge (acknowledge pending bugs to unblock tools), comment (append a Markdown comment to an issue), publish/sync/import/link/pullSequence (GitHub, via the gh CLI; only publish and sync use the network)',
      issuesSchema,
      async (args, abortSignal) => {
        // Initialize tracker on first use
        await initializeTracker();

        switch (args.action) {
          case 'list': {
            // An id names one issue: it returns in full, and the other filters do not apply.
            if (args.id !== undefined) {
              const issue = (await getIssues({ includeCompleted: true })).find(i => i.id === args.id);
              if (!issue) {
                return createErrorResponse('ISSUES_NOT_FOUND', {
                  id: args.id,
                  message: 'No issue carries that ID.',
                });
              }
              return createSuccessResponse('ISSUES_LIST', {
                count: 1,
                bugCount: issue.type === 'bug' ? 1 : 0,
                featureCount: issue.type === 'feature' ? 1 : 0,
                pendingCount: issue.status === 'pending' ? 1 : 0,
                issuesList: formatIssuesList([issue]),
                details: formatIssueDetails(issue),
                bodiesOmitted: false,
                search: null,
                includeCompleted: true,
              });
            }

            const filter: { type?: IssueType; status?: IssueStatus; includeCompleted?: boolean; labels?: string[] } = {};
            if (args.type) filter.type = args.type;
            if (args.status) filter.status = args.status;
            if (args.includeCompleted) filter.includeCompleted = true;
            if (args.labels && args.labels.length > 0) filter.labels = args.labels;

            let issues = await getIssues(filter);

            // Apply search filter
            if (args.search) {
              const searchLower = args.search.toLowerCase();
              issues = issues.filter(i =>
                i.id.toString() === args.search ||
                i.title.toLowerCase().includes(searchLower) ||
                i.body.toLowerCase().includes(searchLower) ||
                i.recordingName.toLowerCase().includes(searchLower) ||
                i.comments.some(c => c.text.toLowerCase().includes(searchLower))
              );
            }

            // Get counts from filtered list
            const bugCount = issues.filter(i => i.type === 'bug').length;
            const featureCount = issues.filter(i => i.type === 'feature').length;
            const pendingCount = issues.filter(i => i.status === 'pending').length;

            const rendersDetails = issues.length > 0 && issues.length <= DETAIL_RENDER_LIMIT;

            return createSuccessResponse('ISSUES_LIST', {
              count: issues.length,
              bugCount,
              featureCount,
              pendingCount,
              issuesList: formatIssuesList(issues),
              details: rendersDetails ? issues.map(formatIssueDetails).join('\n\n---\n\n') : null,
              bodiesOmitted: !rendersDetails && issues.length > 0,
              search: args.search || null,
              includeCompleted: args.includeCompleted || false,
            });
          }

          case 'create': {
            if (!args.type) {
              return createErrorResponse('ISSUES_MISSING_TYPE', {
                message: 'Issue type is required (bug or feature)',
              });
            }

            if (!args.title) {
              return createErrorResponse('ISSUES_MISSING_TITLE', {
                message: 'Issue title is required',
              });
            }

            // Check if sequence should be included (default: true)
            const includeSequence = args.includeSequence !== false;

            // Reject about:blank as user-provided startUrl (reserved as sentinel for includeSequence: false)
            if (args.startUrl === 'about:blank') {
              return createErrorResponse('ISSUES_INVALID_START_URL', {
                message: 'about:blank is not allowed as startUrl. Use includeSequence: false to create an issue without sequence recording.',
              });
            }

            // Check if localhost URL has an active server
            if (args.startUrl) {
              const portCheck = await checkUrlPort(args.startUrl);
              if (portCheck && !portCheck.open) {
                return createErrorResponse('ISSUES_LOCALHOST_NOT_ACTIVE', {
                  startUrl: args.startUrl,
                  port: portCheck.port,
                  message: `No server running on localhost:${portCheck.port}. Start the server before creating the issue.`,
                });
              }
            }

            // Require startUrl when no sequence is provided and includeSequence is true
            if (includeSequence && !args.sequenceName && !args.startUrl) {
              return createErrorResponse('ISSUES_MISSING_START_URL', {
                message: 'startUrl is required when no sequenceName is provided (needed for verification). Use includeSequence: false to skip sequence creation.',
              });
            }

            let sequenceFile = '';

            // If sequenceName provided, move/copy sequence to issues folder
            if (args.sequenceName && getSequencePath) {
              const sourcePath = await getSequencePath(args.sequenceName);

              if (sourcePath) {
                // Generate new filename for issues folder
                // We'll use a temporary ID, then update after creating the issue
                const tempId = Date.now();
                const newFilename = generateSequenceFilename(args.type, tempId, args.title);
                const destPath = join(getIssueSequencesDir(), newFilename);

                try {
                  // Copy the sequence file
                  await fs.copyFile(sourcePath, destPath);
                  sequenceFile = newFilename;
                } catch (error: any) {
                  return createErrorResponse('ISSUES_SEQUENCE_COPY_FAILED', {
                    sequenceName: args.sequenceName,
                    error: error.message,
                  });
                }
              } else {
                return createErrorResponse('ISSUES_SEQUENCE_NOT_FOUND', {
                  sequenceName: args.sequenceName,
                  message: `Sequence "${args.sequenceName}" not found`,
                });
              }
            }

            // Manually created issues start as acknowledged (no blocking)
            // When includeSequence is false, use about:blank as sentinel to skip recording on resolve
            const effectiveStartUrl = !includeSequence ? 'about:blank' : (args.startUrl || '');
            const issue = await addIssue({
              type: args.type,
              title: args.title,
              sequenceFile,
              recordingName: args.sequenceName || 'manual',
              initialStatus: 'acknowledged',
              startUrl: effectiveStartUrl,
              body: args.body,
              labels: args.labels,
            });

            // If we created a sequence file with temp ID, rename it with real ID
            if (sequenceFile && args.sequenceName) {
              const correctFilename = generateSequenceFilename(args.type, issue.id, args.title);
              if (correctFilename !== sequenceFile) {
                const oldPath = join(getIssueSequencesDir(), sequenceFile);
                const newPath = join(getIssueSequencesDir(), correctFilename);
                try {
                  await fs.rename(oldPath, newPath);
                  await updateIssueSequenceFile(issue.id, correctFilename);
                  issue.sequenceFile = correctFilename;
                } catch {
                  // Keep old filename if rename fails
                }
              }
            }

            return createSuccessResponse('ISSUES_CREATED', {
              id: issue.id,
              type: issue.type,
              title: issue.title,
              sequenceFile: issue.sequenceFile || null,
            });
          }

          case 'workOn': {
            if (!args.id) {
              return createErrorResponse('ISSUES_MISSING_ID', {
                message: 'Issue ID is required',
              });
            }

            const issue = await getIssue(args.id);
            if (!issue) {
              return createErrorResponse('ISSUES_NOT_FOUND', {
                id: args.id,
                message: `Issue #${args.id} not found`,
              });
            }

            // Update status to in_progress
            await updateIssueStatus(args.id, 'in_progress');

            // Use provided connectionReason or generate one
            let connectionRef: string | null = null;
            if (args.connectionReason) {
              connectionRef = requireValidReference(args.connectionReason);
            } else {
              connectionRef = `${issue.type} ${issue.id} workOn`;
            }

            const hasSequence = !!issue.sequenceFile;

            // Register cleanup on abort signal to close browser tab if the
            // call is cancelled mid-work. The listener MUST be detached once
            // this handler settles: as a sequence step the signal is the
            // RUN's long-lived signal, so a permanent listener would (a)
            // accumulate one per issues step and (b) close this step's tab
            // when the run is cancelled minutes after the step finished.
            let detachAbortListener: (() => void) | undefined;
            if (abortSignal && connectionRef) {
              const onAbort = () => {
                executeToolCall('tab', { action: 'close', reference: connectionRef }).catch(() => {});
              };
              abortSignal.addEventListener('abort', onAbort, { once: true });
              detachAbortListener = () => abortSignal.removeEventListener('abort', onAbort);
            }

            try {
              if (hasSequence) {
                // Auto-replay sequence if available
                const sequencePath = join(getIssueSequencesDir(), issue.sequenceFile!);
                const sequenceName = issue.sequenceFile!.replace(/\.json$/, '');

                // Load and run sequence (errors propagate via ToolError)
                await executeToolCall('replay', {
                  action: 'load',
                  filename: sequencePath,
                });

                await executeToolCall('replay', {
                  action: 'run',
                  // Blocking: workOn's response reports the replay's outcome, so
                  // the run must complete (or fail) before we return.
                  wait: true,
                  name: sequenceName,
                  connectionReason: connectionRef,
                  // A repro that spans two browsers has per-step references from
                  // the session that recorded it; without this there is no way to
                  // rebind them and the repro cannot run here at all.
                  ...(args.connections && { connections: args.connections }),
                  showReplayOverlay: true,
                  issueId: issue.id,
                  issueType: issue.type,
                  issueTitle: issue.title,
                });
              } else if (issue.startUrl && getPageForConnection) {
                // No sequence but has startUrl - launch browser, navigate, and show options overlay
                let page = await getPageForConnection(connectionRef);
                if (!page) {
                  // Auto-launch Chrome
                  try {
                    await executeToolCall('launchChrome', {
                      reference: connectionRef,
                    });
                    page = await getPageForConnection(connectionRef);
                  } catch (error: any) {
                    return createErrorResponse('ISSUES_CHROME_LAUNCH_FAILED', {
                      message: `Failed to launch Chrome: ${error.message}`,
                    });
                  }
                }

                if (!page) {
                  return createErrorResponse('ISSUES_PAGE_ERROR', {
                    message: 'Failed to get browser page after launch',
                  });
                }

                // Navigate to startUrl
                await executeToolCall('navigate', {
                  action: 'goto',
                  connectionReason: connectionRef,
                  url: issue.startUrl,
                  waitUntil: 'load',
                });

                // Refresh page reference after navigation
                page = await getPageForConnection(connectionRef);
                if (!page) {
                  return createErrorResponse('ISSUES_PAGE_ERROR', {
                    message: 'Lost browser page after navigation',
                  });
                }

                // Show overlay with options: Cancel, Explore, or Record
                const overlayConfig = getWorkOnNoSequenceConfig(issue.type, issue.id, issue.title);
                const result = await showOverlay(page, overlayConfig);

                if (result.action === 'cancel') {
                  return createSuccessResponse('ISSUES_WORK_CANCELLED', {
                    id: issue.id,
                    type: issue.type,
                    title: issue.title,
                    message: 'Work session cancelled by user',
                  });
                }

                if (result.action === 'record') {
                  // Start recording user's actions - this blocks until recording completes
                  const recordingResult = await executeToolCall('replay', {
                    action: 'recordInteraction',
                    connectionReason: connectionRef,
                    name: `${issue.type}-${issue.id}-repro`,
                    startUrl: issue.startUrl,
                    issueId: issue.id,
                    issueType: issue.type,
                    issueTitle: issue.title,
                  });

                  // Return the recording result directly so user sees what was recorded
                  return recordingResult;
                }

                // action === 'explore' - just leave browser open for manual exploration
              }

              return createSuccessResponse('ISSUES_WORK_STARTED', {
                id: issue.id,
                type: issue.type,
                title: issue.title,
                sequenceFile: issue.sequenceFile || null,
                details: formatIssueDetails(issue),
                replayStarted: hasSequence,
                browserLaunched: !hasSequence && !!issue.startUrl,
                connectionReason: connectionRef,
              });
            } finally {
              detachAbortListener?.();
            }
          }

          case 'resolve': {
            if (!args.id) {
              return createErrorResponse('ISSUES_MISSING_ID', {
                message: 'Issue ID is required',
              });
            }

            // resolve is human-gated by construction: the only thing that can
            // settle showTestReadyOverlay/showVerificationOverlay is a real
            // click in the browser, so an agent calling this cannot close an
            // issue - it can only wait. That wait is what the bounded timeout
            // below exists to cap. We deliberately do NOT try to detect an
            // agent caller up front: the overlay already enforces the policy,
            // and every available signal for "who is calling" is a heuristic
            // that risks refusing a genuine human.
            if (!getPageForConnection) {
              return createErrorResponse('ISSUES_NO_PAGE_ACCESS', {
                message: 'Cannot access browser page for verification',
              });
            }

            const issue = await getIssue(args.id);
            if (!issue) {
              return createErrorResponse('ISSUES_NOT_FOUND', {
                id: args.id,
                message: `Issue #${args.id} not found`,
              });
            }

            // Generate a unique reference for this resolve session
            const connectionRef = `${issue.type} ${issue.id} resolve`;

            // Always create a fresh tab for resolve verification
            let page = await getPageForConnection(connectionRef);
            if (!page) {
              // Try to create a new tab first (if Chrome is already running)
              try {
                await executeToolCall('tab', {
                  action: 'create',
                  reference: connectionRef,
                });
                page = await getPageForConnection(connectionRef);
              } catch {
                // Chrome not running - launch it
                try {
                  await executeToolCall('launchChrome', {
                    reference: connectionRef,
                  });
                  page = await getPageForConnection(connectionRef);
                } catch (error: any) {
                  return createErrorResponse('ISSUES_CHROME_LAUNCH_FAILED', {
                    message: `Failed to launch Chrome: ${error.message}`,
                  });
                }
              }
            }

            if (!page) {
              return createErrorResponse('ISSUES_PAGE_ERROR', {
                message: 'Failed to get browser page after launch',
              });
            }

            const hasSequence = !!issue.sequenceFile;
            // about:blank with no sequence means skip straight to completion overlay
            const skipToCompletion = !hasSequence && issue.startUrl === 'about:blank';

            // Navigate to startUrl first (before showing overlay) if no sequence
            if (!hasSequence) {
              // Use startUrl if available, otherwise about:blank
              const targetUrl = issue.startUrl || 'about:blank';
              // executeToolCall throws on error
              await executeToolCall('navigate', {
                action: 'goto',
                connectionReason: connectionRef,
                url: targetUrl,
                waitUntil: 'load',
              });

              // Refresh page reference after navigation
              page = await getPageForConnection(connectionRef);
              if (!page) {
                return createErrorResponse('ISSUES_PAGE_ERROR', {
                  message: 'Lost browser page after navigation',
                });
              }
            }

            // Skip "Ready to begin?" overlay if this is a no-sequence issue
            let readyAction: string | undefined;
            if (skipToCompletion) {
              readyAction = 'begin'; // Simulate clicking begin
            } else {
              // Bound the wait for a human response: if nobody ever clicks the
              // overlay (e.g. the person walked away), fail with a typed error
              // instead of letting Puppeteer's own ~180s protocolTimeout leak
              // through as a raw "Runtime.callFunctionOn timed out".
              try {
                readyAction = await withVerificationTimeout(
                  showTestReadyOverlay(page, issue.type, issue.title, issue.id, hasSequence),
                  DEFAULT_RESOLVE_VERIFICATION_TIMEOUT_MS,
                  issue.id
                );
              } catch (error) {
                if (error instanceof IssuesResolveTimeoutError) {
                  if (!args.keepBrowserOpen) {
                    try {
                      await executeToolCall('tab', { action: 'close', reference: connectionRef });
                    } catch {
                      // Non-fatal
                    }
                  }
                  return createErrorResponse('ISSUES_RESOLVE_TIMEOUT', {
                    id: issue.id,
                    timeoutSeconds: Math.round(DEFAULT_RESOLVE_VERIFICATION_TIMEOUT_MS / 1000),
                  });
                }
                throw error;
              }
            }

            if (readyAction === 'cancel') {
              return createSuccessResponse('ISSUES_VERIFICATION_CANCELLED', {
                id: issue.id,
                type: issue.type,
                title: issue.title,
                message: 'Verification cancelled by user',
              });
            }

            // Handle re-record: start recording instead of replaying
            if (readyAction === 'rerecord') {
              // Start recording user's actions to replace existing sequence
              // recordInteraction will navigate to startUrl if provided
              const recordingResult = await executeToolCall('replay', {
                action: 'recordInteraction',
                connectionReason: connectionRef,
                name: `${issue.type}-${issue.id}-repro`,
                startUrl: issue.startUrl || 'about:blank',
                issueId: issue.id,
                issueType: issue.type,
                issueTitle: issue.title,
                overwrite: true,
              });

              // Cancellation from `_meta`: searching the sentence for
              // "cancelled" also matched a recorded page whose own text
              // happened to contain the word.
              const resultText = recordingResult?.content?.[0]?.text || '';
              if (recordingResult?._meta?.replay?.cancelled) {
                return recordingResult;
              }

              // Return with clear instruction to run resolve again
              return createSuccessResponse('ISSUES_SEQUENCE_RERECORDED', {
                type: issue.type,
                id: issue.id,
                recordingDetails: resultText,
              });
            }

            // Play the sequence if available, otherwise record user actions
            // Track replay execution results to surface to user
            let replayResult: any = null;

            if (hasSequence) {
              const sequencePath = join(getIssueSequencesDir(), issue.sequenceFile!);
              const sequenceName = issue.sequenceFile!.replace(/\.json$/, '');

              const closeVerificationTab = async () => {
                if (args.keepBrowserOpen) return;
                try {
                  await executeToolCall('tab', { action: 'close', reference: connectionRef });
                } catch {
                  // Non-fatal
                }
              };

              // A run that FAILS returns normally and is read below; a run that
              // cannot start at all (missing sequence file, Chrome refused to
              // launch) THROWS. That throw used to escape this handler, so the
              // verification browser was left open on the one path where the
              // user is least likely to be watching it.
              let replayText: string;
              try {
                await executeToolCall('replay', {
                  action: 'load',
                  filename: sequencePath,
                });

                replayResult = await executeToolCall('replay', {
                  action: 'run',
                  // Blocking: the failure check below parses the run's result.
                  wait: true,
                  name: sequenceName,
                  connectionReason: connectionRef,
                  ...(args.connections && { connections: args.connections }),
                  showReplayOverlay: true,
                  issueId: issue.id,
                  issueType: issue.type,
                  issueTitle: issue.title,
                });
                replayText = replayResult?.content?.[0]?.text || '';
              } catch (replayError: any) {
                await closeVerificationTab();
                return createErrorResponse('ISSUES_REPLAY_FAILED', {
                  id: issue.id,
                  type: issue.type,
                  title: issue.title,
                  replayDetails: replayError?.response?.content?.[0]?.text
                    || replayError?.message
                    || 'The replay tool failed to run the sequence.',
                });
              }

              // From the run's own `_meta`, not its rendered summary: the text
              // form coupled this to the exact "**Failed:** 0" wording in
              // replay-formatters, so a reformat there would have silently
              // turned every failed verification into a pass.
              const runMeta = replayResult?._meta?.replay;
              const replayFailed = runMeta?.success === false || (runMeta?.failedSteps ?? 0) > 0;

              if (replayFailed) {
                await closeVerificationTab();

                // Return error immediately with replay details
                return createErrorResponse('ISSUES_REPLAY_FAILED', {
                  id: issue.id,
                  type: issue.type,
                  title: issue.title,
                  replayDetails: replayText,
                });
              }
            } else if (!skipToCompletion) {
              // No sequence and not skipping - start recording user's actions (executeToolCall throws on error)
              const recordingResult = await executeToolCall('replay', {
                action: 'recordInteraction',
                connectionReason: connectionRef,
                name: `verify-${issue.type}-${issue.id}`,
                startUrl: issue.startUrl || 'about:blank',
                // Pass issue info so recording saves to issues folder
                issueId: issue.id,
                issueType: issue.type,
                issueTitle: issue.title,
              });

              // Cancellation from `_meta`: searching the sentence for
              // "cancelled" also matched a recorded page whose own text
              // happened to contain the word.
              const resultText = recordingResult?.content?.[0]?.text || '';
              if (recordingResult?._meta?.replay?.cancelled) {
                return recordingResult;
              }

              // Return with instruction to run resolve again to verify with new sequence
              return createSuccessResponse('ISSUES_SEQUENCE_RERECORDED', {
                type: issue.type,
                id: issue.id,
                recordingDetails: resultText,
              });
            }
            // If skipToCompletion, we fall through directly to verification overlay

            // Refresh page reference after replay (in case it changed)
            page = await getPageForConnection(connectionRef);
            if (!page) {
              return createErrorResponse('ISSUES_PAGE_ERROR', {
                message: 'Lost browser page during replay',
              });
            }

            // Show verification overlay and wait for user response - bounded
            // the same way as the "ready to begin?" overlay above.
            let verification: Awaited<ReturnType<typeof showVerificationOverlay>>;
            try {
              verification = await withVerificationTimeout(
                showVerificationOverlay(page, issue.type, issue.title, issue.id),
                DEFAULT_RESOLVE_VERIFICATION_TIMEOUT_MS,
                issue.id
              );
            } catch (error) {
              if (error instanceof IssuesResolveTimeoutError) {
                if (!args.keepBrowserOpen) {
                  try {
                    await executeToolCall('tab', { action: 'close', reference: connectionRef });
                  } catch {
                    // Non-fatal
                  }
                }
                return createErrorResponse('ISSUES_RESOLVE_TIMEOUT', {
                  id: issue.id,
                  timeoutSeconds: Math.round(DEFAULT_RESOLVE_VERIFICATION_TIMEOUT_MS / 1000),
                });
              }
              throw error;
            }

            // Close the tab after verification (unless keepBrowserOpen is true)
            if (!args.keepBrowserOpen) {
              try {
                await executeToolCall('tab', {
                  action: 'close',
                  reference: connectionRef,
                });
              } catch (error: any) {
                // Non-fatal - tab close failed but verification completed
              }
            }

            // Extract replay execution details if available
            let replayDetails: any = null;
            if (replayResult?.content?.[0]?.text) {
              replayDetails = replayResult.content[0].text;
            }

            // Fold the verification comment into the issue's permanent Markdown timeline
            if (verification.comment) {
              await addIssueComment(args.id, verification.comment);
            }

            if (verification.resolved) {
              // User confirmed resolution
              const newStatus: IssueStatus = completedStatusFor(issue.type);
              await updateIssueStatus(args.id, newStatus);

              return createSuccessResponse('ISSUES_RESOLVED', {
                id: issue.id,
                type: issue.type,
                status: newStatus,
                title: issue.title,
                userComment: verification.comment || null,
                replayDetails,
              });
            } else {
              // User said not resolved - include replay details so user can see what happened
              return createSuccessResponse('ISSUES_NOT_RESOLVED', {
                id: issue.id,
                type: issue.type,
                status: issue.status,
                title: issue.title,
                userComment: verification.comment || null,
                replayDetails,
              });
            }
          }

          case 'acknowledge': {
            const acknowledged = await acknowledgeAllBugs();

            if (acknowledged.length === 0) {
              return createSuccessResponse('ISSUES_NONE_PENDING', {
                message: 'No pending bugs to acknowledge',
              });
            }

            const bugList = acknowledged.map(b => `- #${b.id}: ${b.title}`).join('\n');

            return createSuccessResponse('ISSUES_ACKNOWLEDGED', {
              count: acknowledged.length,
              bugList,
            });
          }

          case 'comment': {
            if (!args.id) {
              return createErrorResponse('ISSUES_MISSING_ID', {
                message: 'Issue ID is required',
              });
            }

            if (!args.text) {
              return createErrorResponse('ISSUES_MISSING_TEXT', {
                message: 'Comment text is required',
              });
            }

            const issue = await getIssue(args.id);
            if (!issue) {
              return createErrorResponse('ISSUES_NOT_FOUND', {
                id: args.id,
                message: `Issue #${args.id} not found`,
              });
            }

            const updated = await addIssueComment(args.id, args.text);

            return createSuccessResponse('ISSUES_COMMENT_ADDED', {
              id: issue.id,
              type: issue.type,
              title: issue.title,
              commentCount: updated?.comments.length ?? issue.comments.length,
              timeline: formatCommentTimeline(updated ?? issue),
            });
          }

          case 'publish':
          case 'sync':
          case 'import':
          case 'link':
          case 'pullSequence': {
            if (!isGithubEnabled()) return createErrorResponse('ISSUES_GITHUB_DISABLED');

            const githubArgs = {
              id: args.id, github: args.github,
              repo: args.repo ?? (configManager.getConfig().github?.repo || undefined),
              confirm: args.confirm,
              take: args.take, fromComment: args.fromComment,
              allowPrivilegedSteps: args.allowPrivilegedSteps, type: args.type,
            };
            const deps = { runOpts: { signal: abortSignal }, knownTools: getKnownToolNames };

            if (args.action === 'publish') return handlePublish(githubArgs, deps);
            if (args.action === 'sync') return handleSync(githubArgs, deps);
            if (args.action === 'import') return handleImport(githubArgs, deps);
            if (args.action === 'link') return handleLink(githubArgs);
            return handlePullSequence(githubArgs, deps);
          }

          default: {
            return createErrorResponse('ISSUES_INVALID_ACTION', {
              action: (args as any).action,
              message: `Unknown action: ${(args as any).action}`,
            });
          }
        }
      }
    ),
  };
}
