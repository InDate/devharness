/**
 * The bench - hold the page still, point at what is wrong, type a few words.
 *
 * Prose is the expensive part of reporting a UI bug: the toast has gone by the
 * time it is described, and "the row under the header" stays ambiguous. This
 * takes a click on the element in place of the description, and holds time still so
 * a state that only exists mid-interaction is still on screen to be clicked.
 *
 * Holding the screen is two clocks, not one. Debugger.pause stops the page's JS, and with
 * it every timer and rAF callback; CSS animations run on the compositor and
 * keep going until Animation.setPlaybackRate(0) stops them separately.
 *
 * Stepping runs to the next scheduled callback rather than advancing a clock.
 * Emulation.setVirtualTimePolicy would give exact millisecond steps, but it is
 * a one-way door: it replaces the page's clock with a synthetic one and has no
 * off switch, so the tab can never be handed back working - `advance` runs away
 * at thousands of times real speed, and neither detaching nor reloading clears
 * it. Stepping by callback lands exactly on the boundaries where state actually
 * changes, reports the page time it reached, and releases cleanly.
 *
 * Nothing is injected into the page being driven. Picking is Chrome's own
 * picker (Overlay.setInspectMode), which is browser-side and keeps working
 * however hard the page is frozen; the comment box lives in a separate control
 * tab (`bench-control.ts`), because a frozen page cannot accept a keystroke
 * and its DOM should not be edited by the act of writing about it.
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
export { cancelSequence, commentSequenceStep, describeSequence, dismissSequenceFailure, editSequenceStep, getSequenceState, gotoSequenceStep, insertSequenceCheck, insertSequenceTimer, moveSequenceStep, playSequence, removeSequence, removeSequenceStep, removeSequenceVariable, selectSequence, setSequenceBaseUrl, setSequenceSecret, setSequenceVariable, stepSequence } from './bench-mode/sequence.js';
export { type BenchReport, type ResponseUse, forgetBenchSession, getBenchSession, isBenchOpen, pageHeldElsewhere, runningBench } from './bench-mode/session.js';
export { stepTallies, stepTimes } from './bench-mode/tallies.js';
