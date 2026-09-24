/**
 * Shared by the command recorder and the bench. Kept apart from `bench-mode`
 * so the recorder takes the shapes without taking the bench's session state.
 */

/** Where a picked element came from, as far as the page will admit. */
export interface AnnotationTarget {
  tag: string;
  /** How the element is found again - what the pane highlights on hover. */
  selector: string;
  text?: string;
  testId?: string;
  rect?: { x: number; y: number; width: number; height: number };
  /** Framework component that rendered it, when a dev build exposes one. */
  component?: string;
  /** file:line from a dev build's JSX source prop, checked against the file. */
  source?: { fileName: string; lineNumber?: number; columnNumber?: number; corrected?: boolean };
}

/** Stored inside its sequence's command, which is the state it was taken in. */
export interface Annotation {
  id: string;
  at: string;
  url: string;
  /** Milliseconds the page had been allowed to run when this was recorded. */
  tick: number;
  comment: string;
  /**
   * The element this note is about, when it is about one.
   *
   * A note against a step needs no element - "this step is flaky" points at
   * nothing on the page - and requiring a pick for it made the box refuse the
   * note without saying so.
   */
  target?: AnnotationTarget;
  /** Pictures taken with the note, in the order they were accepted. */
  screenshots?: string[];
}

/**
 * What crossed the app's boundary while one step was the action in play.
 *
 * Stored on the step, next to the notes it is evidence for: a note saying a
 * button double-posts is worth nothing without the record of the posts, and
 * the record is a property of that run, not of the connection.
 */
export interface StepTraffic {
  requests: number;
  failed: number;
  /** Transports this action opened. What they later carry is not counted here:
   *  a socket opened by one action can be sent on by another, and what comes
   *  back belongs where it arrived. */
  opened: number;
  /** localStorage and sessionStorage writes, which cross no boundary at all. */
  writes: number;
  /** One line each, `POST /draft 200`, capped. */
  lines: string[];
  /**
   * What crossed the boundary under this step, as weighted counts per payload
   * shape, read from the proxy at record time.
   *
   * Stored rather than recomputed: the proxy holds its events in memory for
   * the session that captured them, so a sequence replayed tomorrow has
   * nothing left to read. Counts alone miss a step whose traffic changed
   * entirely while its total held.
   */
  shapes?: Record<string, number>;
  /**
   * How many of each payload shape crossed, unweighted.
   *
   * Ownership and presence answer different questions. A push a step does not
   * own weighs nothing, so a server that stops pushing on replay is invisible
   * to `shapes` and visible here.
   */
  seen?: Record<string, number>;
  /**
   * How long this step's bucket was held open, in ms.
   *
   * A recorded step lasts until the next command is issued, which is however
   * long the person or agent took. A replayed step lasts milliseconds. Unowned
   * events land in a step by that duration, so a drift on a long-held step
   * reads as a window mismatch before it reads as changed behaviour - and
   * without this number there is nothing to read it against.
   */
  windowMs?: number;
}
