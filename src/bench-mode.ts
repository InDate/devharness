/**
 * The bench - hold the page still, point at what is wrong, type a few words.
 *
 * Prose is the expensive part of reporting a UI bug: the toast has gone by the
 * time it is described, and "the row under the header" stays ambiguous. This
 * takes a click on the element in place of the description, and holds time still so
 * a state that only exists mid-interaction is still on screen to be clicked.
 *
 * Holding the screen stops three clocks. Debugger.pause stops the page's JS;
 * CSS animations run on the compositor and keep going until
 * Animation.setPlaybackRate(0) stops them separately; and wall time, which a
 * paused debugger does not stop, would bring every timer due during the hold
 * and jump every Date and performance.now read by its length, so the page
 * reads time from a clock of devharness's (`page-clock.ts`) that the hold
 * stops as well.
 *
 * Emulation.setVirtualTimePolicy would own those clocks from inside Chrome,
 * but it is a one-way door: it has no off switch, so the tab can never be
 * handed back working, and `advance` runs away at thousands of times real
 * speed. The page clock runs at wall time until held, and steps by a callback
 * or a frame land on the boundaries where state actually changes.
 *
 * Two scripts of devharness's go into the page being driven, both before the
 * app's first line: the page clock, and the network monitor's send wrapper.
 * Nothing else is. Picking is Chrome's own picker (Overlay.setInspectMode),
 * which is browser-side and keeps working however hard the page is frozen;
 * the comment box lives in a separate control tab (`bench-control.ts`),
 * because a frozen page cannot accept a keystroke and its DOM should not be
 * edited by the act of writing about it.
 */

export type { Annotation, AnnotationTarget, StepTraffic } from './annotation.js';
export type {
  BenchView, BoundaryRule, CallbackEntry, PendingShot, SequenceCard, SequenceState,
  SequenceStep, SequenceVariable, TickResult,
} from './bench/wire.js';

export { DESCRIBE_ELEMENT, discardPick, getPendingPick, highlightAnnotation, moveAnnotation, noteAtStep, notifyAnnotation, removeAnnotation, rewordAnnotation, saveAnnotation, verifySourceLine } from './bench-mode/annotations.js';
export { beginCapture, cancelCapture, captureBenchScreenshot, capturesInFlight, discardBenchScreenshot, readMoreFacts, retakeCapture, saveBenchScreenshot, setFactChoice } from './bench-mode/captures.js';
export { benchHold, changeHold, haltSequence, setHeld, setPicker } from './bench-mode/controls.js';
export { type SequenceDriver } from './bench-mode/driver.js';
export { startBench, stopBench } from './bench-mode/lifecycle.js';
export { stepTraffic, tickBench } from './bench-mode/page-hold.js';
export { addRecordingTimer, addRecordingVariable, cancelRecordingSequence, chooseStepSelector, dropRecordedStep, editRecordingVariable, flagRecordedStep, keepRecordedStep, recordSequence, stopRecordingSequence } from './bench-mode/recording.js';
export { clearBoundaryRule, hideKind, savePayloadFor, setBoundaryName, setBoundaryRule, setHiddenMode, setHiddenUse, setResponseMode, setResponseUse, unhideKind } from './bench-mode/rules.js';
export { baselineSequence, playHere, renameFromHome, runFromHome, runsView, stopRun } from './bench-mode/runs.js';
export { cancelSequence, commentSequenceStep, describeSequence, dismissSequenceFailure, editSequenceStep, getSequenceState, gotoSequenceStep, insertSequenceCheck, insertSequenceTimer, moveSequenceStep, playSequence, removeSequence, removeSequenceStep, removeSequenceVariable, selectSequence, setSequenceBaseUrl, setSequenceEnvFile, setSequenceKeepDeclared, setSequenceSecret, setSequenceVariable, stepSequence } from './bench-mode/sequence.js';
export { type BenchReport, type ResponseUse, forgetBenchSession, getBenchSession, isBenchOpen, pageHeldElsewhere, runningBench } from './bench-mode/session.js';
export { stepTallies, stepTimes } from './bench-mode/tallies.js';
