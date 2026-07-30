/**
 * LingoLoop flow — the connective tissue between upload, pipeline and review.
 *
 * `TranslationFlow` is the whole product on one route: it owns the phase
 * machine, the `fetch` to `/api/translate`, the `AbortController` behind the
 * cancel control, and the hand-off of real `LocaleResult`s to `ReviewPanel`.
 *
 * `machine.ts` is pure and React-free — the transitions, the wire decoders and
 * the failure taxonomy live there and are unit-tested there.
 */

export { TranslationFlow } from "./TranslationFlow";
export type { TranslationFlowProps } from "./TranslationFlow";

export { RunMonitor } from "./RunMonitor";
export type { RunMonitorProps } from "./RunMonitor";

export { FlowErrorPanel } from "./FlowErrorPanel";
export type { FlowErrorPanelProps } from "./FlowErrorPanel";

export {
  INITIAL_FLOW_STATE,
  PHASE_LABEL,
  cancelledFailure,
  decodeJobDone,
  decodeJobError,
  decodeJobStart,
  decodeLocaleResult,
  decodeProgress,
  emptyResultFailure,
  failureFromJobEvent,
  failureFromResponse,
  failureFromTransport,
  flowReducer,
  formatDuration,
  localeTracks,
  runOf,
  runTotals,
  truncatedFailure,
} from "./machine";
export type {
  FlowAction,
  FlowFailure,
  FlowFailureKind,
  FlowPhase,
  FlowState,
  JobDoneEvent,
  JobErrorEvent,
  JobStartEvent,
  LocaleRunState,
  LocaleTrack,
  RunRequest,
  RunState,
  RunTotals,
} from "./machine";
