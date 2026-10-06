import { describe, expect, it } from 'vitest';
import { afterApprove, outcomeStop, reportOf, settleConfirmed, settleInterrupted, settleUnauthorized, startRun, stopRun, withStep } from '../src/approval.js';
import type { ApprovalOutcome, StopReason } from '../src/approval.js';
import type { Fault, Reply } from '../src/broker.js';
import { parseRequest, toInstant } from '../src/parse.js';
import type { Approval, Execution, Request } from '../src/request.js';

function request(id = 'one', approval: Approval = { kind: 'approved' }, execution: Execution = { kind: 'ready' }): Request {
  const parsed = parseRequest({ id, spec: { method: 'otp' }, created_at: '2026-01-01T00:00:00Z', deadline: '2026-01-01T01:00:00Z', approval: 'approved', execution: 'ready' });
  if (parsed.kind !== 'ok') throw new Error('Invalid fixture');
  return { ...parsed.value, approval, execution };
}

const failures: readonly Exclude<Reply<Request>, { kind: 'ok' }>[] = [
  { kind: 'unauthorized' }, { kind: 'conflict' }, { kind: 'not-found' },
  { kind: 'failed', fault: { kind: 'network' } },
  { kind: 'failed', fault: { kind: 'timeout' } },
  { kind: 'failed', fault: { kind: 'unavailable' } },
  { kind: 'failed', fault: { kind: 'protocol' } },
  { kind: 'failed', fault: { kind: 'storage' } },
];

describe('approval reply policy', () => {
  const rows: readonly { reply: Reply<void>; expected: { kind: string; confirm: boolean; stop: boolean } }[] = [
    { reply: { kind: 'ok', value: undefined }, expected: { kind: 'confirm', confirm: true, stop: false } },
    { reply: { kind: 'conflict' }, expected: { kind: 'decided', confirm: true, stop: false } },
    { reply: { kind: 'unauthorized' }, expected: { kind: 'authenticate', confirm: true, stop: true } },
    { reply: { kind: 'not-found' }, expected: { kind: 'missing', confirm: false, stop: true } },
  ];
  it.each(rows)('$reply.kind gives the prescribed next step', ({ reply, expected }) => {
    expect(afterApprove(reply)).toEqual(expected);
  });
  const faults: readonly Fault['kind'][] = ['network', 'timeout', 'unavailable', 'protocol', 'storage'];
  it.each(faults)('%s stops and reconciles without retrying', kind => {
    expect(afterApprove({ kind: 'failed', fault: { kind } })).toEqual({ kind: 'interrupted', confirm: true, stop: true });
  });
});

describe('confirmed settlement', () => {
  const rows: readonly { execution: Execution; kind: string }[] = [
    { execution: { kind: 'ready' }, kind: 'executed' },
    { execution: { kind: 'succeeded' }, kind: 'executed' },
    { execution: { kind: 'consumed' }, kind: 'executed' },
    { execution: { kind: 'failed' }, kind: 'execution-failed' },
    { execution: { kind: 'not-started' }, kind: 'outcome-unknown' },
    { execution: { kind: 'running' }, kind: 'outcome-unknown' },
    { execution: { kind: 'outcome-unknown' }, kind: 'outcome-unknown' },
    { execution: { kind: 'expired' }, kind: 'outcome-unknown' },
    { execution: { kind: 'unrecognized', raw: 'future' }, kind: 'outcome-unknown' },
  ];
  it.each(rows)('approved $execution.kind settles as $kind', ({ execution, kind }) => {
    const value = request('one', { kind: 'approved' }, execution);
    expect(settleConfirmed({ kind: 'ok', value })).toEqual({ kind, request: value });
    expect(settleInterrupted({ kind: 'ok', value })).toEqual({ kind, request: value });
  });
  const approvals: readonly Approval[] = [{ kind: 'pending' }, { kind: 'denied' }, { kind: 'expired' }, { kind: 'cancelled' }, { kind: 'unrecognized', raw: 'future' }];
  it.each(approvals)('$kind cannot turn ready execution into executed', approval => {
    const value = request('one', approval);
    expect(settleConfirmed({ kind: 'ok', value })).toEqual({ kind: 'outcome-unknown', request: value });
  });
  it.each(failures)('$kind cannot establish execution', reply => {
    expect(settleConfirmed(reply)).toEqual({ kind: 'outcome-unknown', request: null });
  });
});

describe('unauthorized settlement', () => {
  it('a readable request establishes key rejection even if already approved', () => {
    const value = request();
    expect(settleUnauthorized({ kind: 'ok', value })).toEqual({ kind: 'key-rejected', request: value });
  });
  const rows: readonly { reply: Exclude<Reply<Request>, { kind: 'ok' }>; expected: string }[] = [
    { reply: { kind: 'unauthorized' }, expected: 'session-ended' },
    { reply: { kind: 'not-found' }, expected: 'key-rejected' },
    { reply: { kind: 'conflict' }, expected: 'auth-undetermined' },
    ...failures.filter(reply => reply.kind === 'failed').map(reply => ({ reply, expected: 'auth-undetermined' })),
  ];
  it.each(rows)('$reply.kind settles as $expected', ({ reply, expected }) => {
    expect(settleUnauthorized(reply)).toEqual({ kind: expected, request: null });
  });
});

describe('interrupted settlement', () => {
  const rows: readonly { approval: Approval; expected: string }[] = [
    { approval: { kind: 'denied' }, expected: 'already-decided' },
    { approval: { kind: 'expired' }, expected: 'already-decided' },
    { approval: { kind: 'cancelled' }, expected: 'already-decided' },
    { approval: { kind: 'pending' }, expected: 'interrupted' },
    { approval: { kind: 'unrecognized', raw: 'future' }, expected: 'interrupted' },
  ];
  it.each(rows)('$approval.kind settles as $expected', ({ approval, expected }) => {
    const value = request('one', approval);
    expect(settleInterrupted({ kind: 'ok', value })).toEqual({ kind: expected, request: value });
  });
  it.each(failures)('$kind leaves the outcome interrupted', reply => {
    expect(settleInterrupted(reply)).toEqual({ kind: 'interrupted', request: null });
  });
  it('keeps a transport failure stop even after successful reconciliation', () => {
    const value = request();
    const outcome = settleInterrupted({ kind: 'ok', value });
    expect(outcome).toEqual({ kind: 'executed', request: value });
    expect(outcomeStop(outcome)).toBe(null);
    expect(afterApprove({ kind: 'failed', fault: { kind: 'network' } })).toEqual({ kind: 'interrupted', confirm: true, stop: true });
  });
});

describe('approval run', () => {
  it('deduplicates in caller order and refuses unknown methods before sending', () => {
    const one = request('one');
    const two: Request = { ...request('two'), operation: { kind: 'unrecognized', raw: 'future' } };
    expect(startRun([{ id: one.id, request: one }, { id: two.id, request: two }, { id: one.id, request: null }])).toEqual({
      kind: 'running', stopped: null, items: [
        { id: one.id, request: one, step: { kind: 'queued' } },
        { id: two.id, request: two, step: { kind: 'done', outcome: { kind: 'not-sent', because: 'not-reviewable' } } },
      ],
    });
    expect(startRun([{ id: one.id, request: null }])).toEqual({ kind: 'finished', stopped: null, items: [{ id: one.id, request: null, step: { kind: 'done', outcome: { kind: 'not-sent', because: 'not-reviewable' } } }] });
    expect(startRun([])).toEqual({ kind: 'finished', items: [], stopped: null });
    expect(startRun([{ id: two.id, request: two }])).toEqual({ kind: 'finished', stopped: null, items: [{ id: two.id, request: two, step: { kind: 'done', outcome: { kind: 'not-sent', because: 'not-reviewable' } } }] });
  });
  it('retains reviewed requests and immutable progress until done', () => {
    const value = request(), id = value.id;
    const initial = startRun([{ id, request: value }]);
    const approving = withStep({ run: initial, id, step: { kind: 'approving', since: toInstant(10) } });
    const confirming = withStep({ run: approving, id, step: { kind: 'confirming', since: toInstant(20) } });
    expect(initial).toEqual({ kind: 'running', stopped: null, items: [{ id, request: value, step: { kind: 'queued' } }] });
    expect(approving).toEqual({ kind: 'running', stopped: null, items: [{ id, request: value, step: { kind: 'approving', since: 10 } }] });
    expect(confirming).toEqual({ kind: 'running', stopped: null, items: [{ id, request: value, step: { kind: 'confirming', since: 20 } }] });
    const finished = withStep({ run: confirming, id, step: { kind: 'done', outcome: { kind: 'outcome-unknown', request: null } } });
    expect(reportOf(finished)).toEqual({ kind: 'finished', stopped: null, items: [{ id, request: value, outcome: { kind: 'outcome-unknown', request: null } }] });
    expect(withStep({ run: finished, id, step: { kind: 'queued' } })).toEqual(finished);
    expect(() => reportOf(initial)).toThrow('Approval run has unfinished items');
  });
  const reasons: readonly StopReason[] = ['key-rejected', 'session-ended', 'auth-undetermined', 'not-found', 'interrupted'];
  it.each(reasons)('%s settles queued items without changing earlier outcomes', reason => {
    const one = request('one'), two = request('two');
    const initial = startRun([{ id: one.id, request: one }, { id: two.id, request: two }]);
    const settled = withStep({ run: initial, id: one.id, step: { kind: 'done', outcome: { kind: 'already-decided', request: one } } });
    const stopped = stopRun(settled, reason);
    expect(reportOf(stopped)).toEqual({ kind: 'finished', stopped: reason, items: [
      { id: one.id, request: one, outcome: { kind: 'already-decided', request: one } },
      { id: two.id, request: two, outcome: { kind: 'not-sent', because: 'batch-stopped' } },
    ] });
    expect(stopRun(stopped, 'interrupted')).toEqual(stopped);
  });
  it('does not claim an in-flight row was never sent', () => {
    const value = request(), id = value.id;
    const active = withStep({ run: startRun([{ id, request: value }]), id, step: { kind: 'approving', since: toInstant(10) } });
    expect(stopRun(active, 'interrupted')).toEqual({ kind: 'running', stopped: 'interrupted', items: [{ id, request: value, step: { kind: 'approving', since: 10 } }] });
  });
});

describe('outcome stop mapping', () => {
  const value = request();
  const rows: readonly { outcome: ApprovalOutcome; expected: StopReason | null }[] = [
    { outcome: { kind: 'executed', request: value }, expected: null },
    { outcome: { kind: 'execution-failed', request: value }, expected: null },
    { outcome: { kind: 'outcome-unknown', request: null }, expected: null },
    { outcome: { kind: 'already-decided', request: null }, expected: null },
    { outcome: { kind: 'not-sent', because: 'not-reviewable' }, expected: null },
    { outcome: { kind: 'not-sent', because: 'batch-stopped' }, expected: null },
    { outcome: { kind: 'key-rejected', request: null }, expected: 'key-rejected' },
    { outcome: { kind: 'session-ended', request: null }, expected: 'session-ended' },
    { outcome: { kind: 'auth-undetermined', request: null }, expected: 'auth-undetermined' },
    { outcome: { kind: 'not-found', request: null }, expected: 'not-found' },
    { outcome: { kind: 'interrupted', request: null }, expected: 'interrupted' },
  ];
  it.each(rows)('$outcome.kind returns its stop reason', ({ outcome, expected }) => {
    expect(outcomeStop(outcome)).toBe(expected);
  });
});
