/**
 * Shared by the command recorder and annotate mode. Importing these from
 * annotate-mode would pull the control pane's page source into the recorder.
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
  target: AnnotationTarget;
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
}
