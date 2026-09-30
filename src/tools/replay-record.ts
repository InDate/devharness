/**
 * `recordInteraction`: recording what a person does in the browser into a
 * sequence, and into issues for the bug and feature notes made while recording.
 */
import type { CommandRecorder, CommandSequence } from '../command-recorder.js';
import type { ExecuteToolCall } from '../types.js';
import { createSuccessResponse, createErrorResponse } from '../messages.js';
import { getIssue } from '../issue-tracker.js';
import { autoLaunchChrome } from './replay-executor.js';
import { formatEventsForReview } from './replay-formatters.js';
import {
  startRecording,
  eventsToCommands,
  generateCondensedTimeline,
  isCommentEvent,
  type CommentEvent,
} from '../interaction-recorder.js';
import {
  addIssue,
  initializeTracker,
  saveIssueSequence,
} from '../issue-tracker.js';
import { configManager } from '../config.js';
import { generatePuppeteerCode, generatePlaywrightCode } from './replay-codegen.js';
import { type ReplayArgs } from './replay-schema.js';

export async function handleRecordInteraction(
  args: ReplayArgs,
  executeToolCall: ExecuteToolCall,
  getPageForConnection?: (connectionReason: string) => Promise<any>,
  recorder?: CommandRecorder,
  abortSignal?: AbortSignal
) {
  if (!args.connectionReason) {
    return createErrorResponse('MISSING_PARAMETER', {
      action: 'recordInteraction',
      missing: 'connectionReason',
      message: 'The "recordInteraction" action requires a "connectionReason" to identify the browser tab'
    });
  }

  /**
   * The failure text, or null when the navigation worked. A failed goto THROWS
   * in production (executeToolCall rethrows isError), so it is caught here;
   * read as a returned response, the NAVIGATION_FAILED answers below would
   * never be reached and the recorder would record against whatever page is
   * open. Same try/catch shape navigateToStartUrl uses.
   */
  const navigateTo = async (url: string): Promise<string | null> => {
    try {
      const navResult = await executeToolCall('navigate', {
        action: 'goto',
        connectionReason: args.connectionReason!,
        url
      });
      return navResult?.isError ? (navResult?.content?.[0]?.text || 'Unknown error') : null;
    } catch (navError: any) {
      return navError?.response?.content?.[0]?.text || navError?.message || 'Unknown error';
    }
  };

  if (!getPageForConnection) {
    return createErrorResponse('NOT_SUPPORTED', {
      message: 'Interaction recording is not supported in this context'
    });
  }

  // If issueId is provided, look up the issue and use its details
  let issueId = args.issueId;
  let issueType = args.issueType;
  let issueTitle = args.issueTitle;
  let startUrl = args.startUrl;

  if (issueId) {
    const issue = await getIssue(issueId);
    if (!issue) {
      return createErrorResponse('ISSUES_NOT_FOUND', {
        id: issueId,
        message: `Issue #${issueId} not found`
      });
    }
    // Use issue details (override any provided args)
    issueType = issue.type;
    issueTitle = issue.title;
    startUrl = startUrl || issue.startUrl;  // Use provided startUrl or fall back to issue's startUrl
  }

  const sequenceName = args.name || (issueId ? `${issueType}-${issueId}-repro` : args.connectionReason);
  // Refused before anything is launched or recorded: a conflict found after the
  // recording asks for it to be made again under another name.
  if (recorder && !args.overwrite && recorder.sequenceNameExists(sequenceName)) {
    return createSuccessResponse('RECORDING_NAME_CONFLICT', {
      sequenceName,
      connectionReason: args.connectionReason
    });
  }

  let page = await getPageForConnection(args.connectionReason);

  // Auto-launch Chrome if no connection found (requires startUrl)
  if (!page) {
    if (!startUrl) {
      return createErrorResponse('MISSING_PARAMETER', {
        action: 'recordInteraction',
        missing: 'startUrl',
        message: 'Chrome is not running. Provide a "startUrl" or "issueId" (with startUrl) to auto-launch Chrome and navigate before recording.'
      });
    }

    const launchResult = await autoLaunchChrome(executeToolCall, args.connectionReason, 'recordInteraction');
    if (!launchResult.success) {
      return createErrorResponse(launchResult.errorType, {
        reference: args.connectionReason,
        error: launchResult.error
      });
    }

    // Navigate to the startUrl
    const navFailure = await navigateTo(startUrl);
    if (navFailure) {
      return createErrorResponse('NAVIGATION_FAILED', {
        url: startUrl,
        message: `Failed to navigate to startUrl: ${navFailure}`
      });
    }

    // Try getting the page again after launch
    page = await getPageForConnection(args.connectionReason);
    if (!page) {
      return createErrorResponse('CONNECTION_NOT_FOUND', {
        connectionReason: args.connectionReason,
        message: 'Failed to connect to Chrome after auto-launch'
      });
    }
  } else if (startUrl) {
    // Page already exists but startUrl provided - navigate to it
    const navFailure = await navigateTo(startUrl);
    if (navFailure) {
      return createErrorResponse('NAVIGATION_FAILED', {
        url: startUrl,
        message: `Failed to navigate to startUrl: ${navFailure}`
      });
    }
  }

  const showOverlay = args.showOverlay !== false;

  // startRecording blocks until the recording completes. With an issueId it
  // shows a fullscreen overlay with the issue's details.
  const result = await startRecording(page, args.connectionReason, {
    showOverlay,
    closeTabOnDone: args.closeTabOnDone,
    abortSignal,
    issueId
  });

  // Close the tab if requested by the recording result
  if (result.closeTab) {
    try {
      await executeToolCall('connection', {
        action: 'close',
        reason: 'recording finished with closeTabOnDone',
        connectionReason: args.connectionReason,
      });
    } catch {
      // Non-fatal - tab may already be closed
    }
  }

  if (!result.success) {
    if (result.cancelled) {
      return {
        content: [{
          type: 'text',
          text: '**Recording cancelled** - no sequence created.'
        }],
        // Structurally too, so a caller reads `cancelled` rather than searching
        // the sentence for it, which a recorded page title can also contain.
        _meta: {
          tool: 'replay',
          action: 'recordInteraction',
          timestamp: Date.now(),
          replay: { totalSteps: 0, cancelled: true },
        },
      };
    }
    return createErrorResponse('RECORDING_FAILED', { message: result.error });
  }

  // Recording completed - create the sequence
  const recording = result.recording!;
  const summary = recording.summary;

  const replayConfig = configManager.getReplayConfig();
  // Recording options come from args, with these defaults.
  // preferSelectors wins over preferCoordinates when both are set.
  const commands = eventsToCommands(recording.events, {
    simplify: args.simplifyEvents ?? true,
    includeDelays: true,
    includeHovers: args.includeHovers ?? false,
    preferCoordinates: args.preferCoordinates ?? false,
    preferSelectors: args.preferSelectors ?? false,
    maxDelayMs: replayConfig.maxDelayMs,
  });

  // Generate condensed timeline
  const timeline = generateCondensedTimeline(recording.events);

  // Check for BUG and FEATURE comments
  const bugComments = recording.events
    .filter((e): e is CommentEvent => isCommentEvent(e) && e.category === 'bug');
  const featureComments = recording.events
    .filter((e): e is CommentEvent => isCommentEvent(e) && e.category === 'feature');

  const hasIssues = bugComments.length > 0 || featureComments.length > 0;

  // Build sequence data for saving
  const sequenceData: CommandSequence = {
    id: `seq-${Date.now()}`,
    name: sequenceName,
    commands,
    createdAt: Date.now(),
    startUrl: recording.startUrl,
    description: `Recorded from ${args.connectionReason}`,
  };

  // Only create in-memory sequence if no issues (issues go to issues folder only)
  let sequence: CommandSequence | null = null;
  if (!hasIssues && recorder) {
    // Delete existing sequence if overwriting
    if (args.overwrite && recorder.sequenceNameExists(sequenceName)) {
      const existingSeq = recorder.listSequences().find(s => s.name === sequenceName);
      if (existingSeq) {
        recorder.deleteSequence(existingSeq.id);
      }
    }

    // Check for name conflict
    if (recorder.sequenceNameExists(sequenceName) && !args.overwrite) {
      return createSuccessResponse('RECORDING_NAME_CONFLICT', {
        sequenceName,
        connectionReason: args.connectionReason
      });
    }

    sequence = await recorder.createSequenceFromCommands(sequenceName, commands, {
      startUrl: recording.startUrl,
      description: `Recorded from ${args.connectionReason}`,
    });
  }

  const createdIssues: Array<{ id: number; type: string; title: string }> = [];

  // Initialize issue tracker
  await initializeTracker();

  // Create issues and save sequences for each bug/feature comment
  // Each issue gets its own sequence with a unique ID
  for (const comment of [...bugComments, ...featureComments]) {
    const issueType = comment.category as 'bug' | 'feature';

    // Create the issue first (with temp filename, will be updated by saveIssueSequence)
    const issue = await addIssue({
      type: issueType,
      title: comment.text,
      sequenceFile: '',
      recordingName: sequenceName,
      initialStatus: 'pending',
      startUrl: recording.startUrl || '',
    });

    // Create a unique sequence for this issue (each issue gets its own copy)
    const issueSequenceData: CommandSequence = {
      ...sequenceData,
      id: `seq-${Date.now()}-${issue.id}`,
      name: `${issueType}-${issue.id}-repro`,
    };

    // Save sequence and link to issue
    await saveIssueSequence(issue.id, issueType, comment.text, issueSequenceData);

    createdIssues.push({
      id: issue.id,
      type: issueType,
      title: comment.text,
    });
  }

  // If issueId provided, save sequence to issues folder and link to existing issue
  if (issueId && issueType && issueTitle) {
    await saveIssueSequence(
      issueId,
      issueType,
      issueTitle,
      sequenceData,
      `devharness verification sequence for ${issueType} #${issueId}: ${issueTitle}`
    );
  }

  const response = createSuccessResponse('RECORDING_STOPPED', {
    name: sequence?.name || sequenceData.name,
    sequenceId: sequence?.id || sequenceData.id,
    duration: (recording.duration / 1000).toFixed(1),
    startUrl: recording.startUrl,
    commandCount: commands.length,
    clicks: summary.clicks,
    drags: summary.drags,
    scrolls: summary.scrolls,
    keyPresses: summary.keyPresses,
    navigations: summary.navigations > 0 ? summary.navigations : null,
    comments: summary.comments > 0 ? summary.comments : null,
    // Selector coverage. Only surfaced when some click fell back to raw
    // coordinates, because that is the only case the user can act on - a
    // fully selector-based recording needs no warning, and a warning that
    // fires every time stops being read.
    coordinateClicks: summary.coordinatesOnly > 0 ? summary.coordinatesOnly : null,
    coverageNote: summary.coordinatesOnly > 0
      ? `${summary.selectorsAvailable}/${summary.clicks} clicks captured a selector; ${summary.coordinatesOnly} fell back to coordinates${summary.canvasInteractions > 0 ? ` (${summary.canvasInteractions} on canvas, where that is expected)` : ''}. Coordinate clicks break on re-render or layout change.`
      : null,
    timeline: timeline || null,
    bugCount: bugComments.length > 0 ? bugComments.length : null,
    featureCount: featureComments.length > 0 ? featureComments.length : null,
    hasIssues: createdIssues.length > 0,
    issuesCreatedList: createdIssues.length > 0
      ? createdIssues.map(i => `#${i.id} (${i.type})`).join(', ')
      : null,
  });

  // outputFormat dumps the underlying data alongside the summary. The raw
  // events only exist here - a saved sequence keeps commands, not events.
  if (args.outputFormat === 'events') {
    response.content[0].text += `\n\n**Raw recorded events (${recording.events.length})**\n\n\`\`\`json\n${JSON.stringify(recording.events, null, 2)}\n\`\`\``;
  } else if (args.outputFormat === 'commands') {
    response.content[0].text += `\n\n**Commands (JSON)**\n\n\`\`\`json\n${JSON.stringify(commands, null, 2)}\n\`\`\``;
  } else if (args.outputFormat === 'review') {
    response.content[0].text += `\n\n**Event Review (${recording.events.length} raw events)**\n\n${formatEventsForReview(recording.events)}`;
  } else if (args.outputFormat === 'playwright') {
    response.content[0].text += `\n\n**Playwright Code**\n\n\`\`\`typescript\n${generatePlaywrightCode(commands, recording.startUrl)}\n\`\`\``;
  } else if (args.outputFormat === 'puppeteer') {
    response.content[0].text += `\n\n**Puppeteer Code**\n\n\`\`\`javascript\n${generatePuppeteerCode(commands, recording.startUrl)}\n\`\`\``;
  }

  return response;
}
