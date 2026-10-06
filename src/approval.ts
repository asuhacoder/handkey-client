import type { Reply } from './broker.js';
import type { Instant, Request, RequestId } from './request.js';

export type StopReason = 'key-rejected' | 'session-ended' | 'auth-undetermined' | 'not-found' | 'interrupted';
export type ApprovalOutcome =
  | { readonly kind: 'executed'; readonly request: Request }
  | { readonly kind: 'execution-failed'; readonly request: Request }
  | { readonly kind: 'outcome-unknown'; readonly request: Request | null }
  | { readonly kind: 'already-decided'; readonly request: Request | null }
  | { readonly kind: 'key-rejected'; readonly request: Request | null }
  | { readonly kind: 'session-ended'; readonly request: Request | null }
  | { readonly kind: 'auth-undetermined'; readonly request: Request | null }
  | { readonly kind: 'not-found'; readonly request: Request | null }
  | { readonly kind: 'interrupted'; readonly request: Request | null }
  | { readonly kind: 'not-sent'; readonly because: 'batch-stopped' | 'not-reviewable' };
export type ApprovalStep =
  | { readonly kind: 'queued' }
  | { readonly kind: 'approving'; readonly since: Instant }
  | { readonly kind: 'confirming'; readonly since: Instant }
  | { readonly kind: 'done'; readonly outcome: ApprovalOutcome };
export interface ApprovalItem {
  readonly id: RequestId;
  readonly request: Request | null;
  readonly step: ApprovalStep;
}
export interface ApprovalRun {
  readonly kind: 'running' | 'finished';
  readonly items: readonly ApprovalItem[];
  readonly stopped: StopReason | null;
}
export type ApprovalReport =
  | { readonly kind: 'finished'; readonly items: readonly { readonly id: RequestId; readonly request: Request | null; readonly outcome: ApprovalOutcome }[]; readonly stopped: StopReason | null }
  | { readonly kind: 'key-spent' | 'not-registered' | 'busy' | 'empty' };

export function startRun(input: readonly { readonly id: RequestId; readonly request: Request | null }[]): ApprovalRun {
  const seen = new Set<RequestId>();
  const items: ApprovalItem[] = [];
  for (const item of input) {
    if (seen.has(item.id)) continue;
    seen.add(item.id);
    items.push({
      ...item,
      step: item.request?.operation.kind === 'unrecognized'
        ? { kind: 'done', outcome: { kind: 'not-sent', because: 'not-reviewable' } }
        : { kind: 'queued' },
    });
  }
  return { kind: items.every(item => item.step.kind === 'done') ? 'finished' : 'running', items, stopped: null };
}

export function withStep(input: { readonly run: ApprovalRun; readonly id: RequestId; readonly step: ApprovalStep }): ApprovalRun {
  const { run, id, step } = input;
  const items = run.items.map(item => item.id === id && item.step.kind !== 'done' ? { ...item, step } : item);
  return { ...run, items, kind: items.every(item => item.step.kind === 'done') ? 'finished' : 'running' };
}

export function stopRun(run: ApprovalRun, reason: StopReason): ApprovalRun {
  const items: readonly ApprovalItem[] = run.items.map(item => item.step.kind === 'queued'
    ? { ...item, step: { kind: 'done', outcome: { kind: 'not-sent', because: 'batch-stopped' } } }
    : item);
  return { kind: items.every(item => item.step.kind === 'done') ? 'finished' : 'running', items, stopped: run.stopped ?? reason };
}

export function reportOf(run: ApprovalRun): Extract<ApprovalReport, { kind: 'finished' }> {
  return {
    kind: 'finished',
    items: run.items.map(item => {
      if (item.step.kind !== 'done') throw new Error('Approval run has unfinished items');
      return { id: item.id, request: item.request, outcome: item.step.outcome };
    }),
    stopped: run.stopped,
  };
}

export type AfterApprove =
  | { readonly kind: 'confirm' | 'decided'; readonly confirm: true; readonly stop: false }
  | { readonly kind: 'authenticate' | 'interrupted'; readonly confirm: true; readonly stop: true }
  | { readonly kind: 'missing'; readonly confirm: false; readonly stop: true };

export const APPROVE_POLICY = {
  ok: { kind: 'confirm', confirm: true, stop: false },
  conflict: { kind: 'decided', confirm: true, stop: false },
  unauthorized: { kind: 'authenticate', confirm: true, stop: true },
  'not-found': { kind: 'missing', confirm: false, stop: true },
  failed: { kind: 'interrupted', confirm: true, stop: true },
} satisfies Readonly<Record<Reply<void>['kind'], AfterApprove>>;

export function afterApprove(reply: Reply<void>): AfterApprove {
  return APPROVE_POLICY[reply.kind];
}

export function settleConfirmed(reply: Reply<Request>): ApprovalOutcome {
  switch (reply.kind) {
    case 'ok': {
      const request = reply.value;
      if (request.approval.kind !== 'approved') return { kind: 'outcome-unknown', request };
      switch (request.execution.kind) {
        case 'ready': case 'succeeded': case 'consumed': return { kind: 'executed', request };
        case 'failed': return { kind: 'execution-failed', request };
        case 'not-started': case 'running': case 'outcome-unknown': case 'expired': case 'unrecognized':
          return { kind: 'outcome-unknown', request };
        default: { const exhaustive: never = request.execution; return exhaustive; }
      }
    }
    case 'unauthorized': case 'conflict': case 'not-found': case 'failed':
      return { kind: 'outcome-unknown', request: null };
    default: { const exhaustive: never = reply; return exhaustive; }
  }
}

export function settleUnauthorized(reply: Reply<Request>): ApprovalOutcome {
  switch (reply.kind) {
    case 'unauthorized': return { kind: 'session-ended', request: null };
    case 'ok': return { kind: 'key-rejected', request: reply.value };
    case 'not-found': return { kind: 'key-rejected', request: null };
    case 'failed': case 'conflict': return { kind: 'auth-undetermined', request: null };
    default: { const exhaustive: never = reply; return exhaustive; }
  }
}

export function settleInterrupted(reply: Reply<Request>): ApprovalOutcome {
  switch (reply.kind) {
    case 'ok':
      switch (reply.value.approval.kind) {
        case 'approved': return settleConfirmed(reply);
        case 'denied': case 'expired': case 'cancelled': return { kind: 'already-decided', request: reply.value };
        case 'pending': case 'unrecognized': return { kind: 'interrupted', request: reply.value };
        default: { const exhaustive: never = reply.value.approval; return exhaustive; }
      }
    case 'unauthorized': case 'not-found': case 'conflict': case 'failed':
      return { kind: 'interrupted', request: null };
    default: { const exhaustive: never = reply; return exhaustive; }
  }
}

export function outcomeStop(outcome: ApprovalOutcome): StopReason | null {
  switch (outcome.kind) {
    case 'key-rejected': case 'session-ended': case 'auth-undetermined': case 'not-found': case 'interrupted':
      return outcome.kind;
    case 'executed': case 'execution-failed': case 'outcome-unknown': case 'already-decided': case 'not-sent':
      return null;
    default: { const exhaustive: never = outcome; return exhaustive; }
  }
}
