import { afterApprove, outcomeStop, reportOf, settleConfirmed, settleInterrupted, settleUnauthorized, startRun, stopRun, withStep } from './approval.js';
import type { ApprovalReport, ApprovalRun, ApprovalStep, StopReason } from './approval.js';
import { createBroker, readEvents } from './broker.js';
import type { Fault, Reply } from './broker.js';
import { defaultEnvironment, memoryPersistence } from './environment.js';
import type { Environment, Persistence } from './environment.js';
import { claimKey } from './key.js';
import type { DeviceKey } from './key.js';
import { encodeSavedSession, normalizeBrokerUrl, parseSavedSession, toInstant } from './parse.js';
import type { SessionRecord } from './parse.js';
import type { Instant, Request, RequestId, SessionId, SessionSummary } from './request.js';

export const BROKER_API = 'v1';

export type ReadResult<T> = { readonly kind: 'ok'; readonly value: T }
 | { readonly kind: 'not-registered' } | { readonly kind: 'session-ended' }
 | { readonly kind: 'not-found' } | { readonly kind: 'failed'; readonly fault: Fault };
export type RegisterResult = { readonly kind: 'registered'; readonly persistence: 'saved' | 'superseded' | 'failed' }
 | { readonly kind: 'key-spent' } | { readonly kind: 'busy' }
 | { readonly kind: 'invalid-broker-url' } | { readonly kind: 'invalid-device-id' }
 | { readonly kind: 'invalid-name' } | { readonly kind: 'session-limit' } | { readonly kind: 'rejected' }
 | { readonly kind: 'failed'; readonly fault: Fault };
export type KeySessionsResult = { readonly kind: 'ok'; readonly value: readonly SessionSummary[] }
 | { readonly kind: 'key-spent' } | { readonly kind: 'rejected' } | { readonly kind: 'invalid-broker-url' }
 | { readonly kind: 'invalid-device-id' } | { readonly kind: 'failed'; readonly fault: Fault };
export type KeyRevokeResult = { readonly kind: 'ok' } | { readonly kind: 'key-spent' }
 | { readonly kind: 'rejected' } | { readonly kind: 'not-found' }
 | { readonly kind: 'invalid-broker-url' } | { readonly kind: 'invalid-device-id' }
 | { readonly kind: 'failed'; readonly fault: Fault };
export type RevokeResult = { readonly kind: 'ok' } | { readonly kind: 'key-spent' }
 | { readonly kind: 'not-registered' } | { readonly kind: 'not-found' }
 | { readonly kind: 'key-rejected' } | { readonly kind: 'session-ended' }
 | { readonly kind: 'auth-undetermined' } | { readonly kind: 'failed'; readonly fault: Fault };
export type DenyOutcome = { readonly kind: 'denied' } | { readonly kind: 'already-decided' }
 | { readonly kind: 'session-ended' } | { readonly kind: 'not-found' }
 | { readonly kind: 'interrupted' } | { readonly kind: 'not-sent' };
export type DenyReport = { readonly kind: 'finished'; readonly items: readonly { readonly id: RequestId; readonly outcome: DenyOutcome }[];
 readonly stopped: 'session-ended' | 'not-found' | 'interrupted' | null } | { readonly kind: 'not-registered' } | {readonly kind:'busy'};
export type Snapshot = {
 readonly kind: 'register';
 readonly reason: 'never-registered' | 'expired' | 'rejected' | 'signed-out' | 'invalid-saved-session';
 readonly remembered: { readonly brokerUrl: string; readonly deviceId: string } | null;
 readonly approval: ApprovalRun | null;
} | {
 readonly kind: 'active';
 readonly session: { readonly brokerUrl: string; readonly deviceId: string; readonly sessionId: SessionId; readonly viewUntil: Instant };
 readonly pending: readonly Request[]; readonly unreadable: number;
 readonly list: { readonly kind: 'loading' } | { readonly kind: 'fresh'; readonly checkedAt: Instant }
  | { readonly kind: 'stale'; readonly lastCheckedAt: Instant | null; readonly fault: Fault };
 readonly connection: 'connecting' | 'live' | 'retrying';
 readonly approval: ApprovalRun | null;
};

/** One session actor. Subscribe starts the feed. The last unsubscribe releases every timer and stream. */
export interface Handkey {
 /** Listener exceptions are swallowed. */
 readonly subscribe: (listener: () => void) => () => void;
 /** A credential-free snapshot with stable identity between changes. */
 readonly getSnapshot: () => Snapshot;
 /** Coalesces concurrent requests into one list and at most one trailing list. */
 refresh(): Promise<void>;
 /** Claims the key before any guard. A successful session replaces and self-revokes the previous one. */
 register(input: { brokerUrl: string; deviceId: string; name: string; key: DeviceKey }): Promise<RegisterResult>;
 /** Lists live sessions without a view token. Claims and spends the key on every path. */
 listSessionsWithKey(input: { brokerUrl: string; deviceId: string; key: DeviceKey }): Promise<KeySessionsResult>;
 /** Revokes a session without a view token. Claims and spends the key on every path. */
 revokeSessionWithKey(input: { brokerUrl: string; deviceId: string; sessionId: SessionId; key: DeviceKey }): Promise<KeyRevokeResult>;
 /** Lists the active device's sessions using only its view token. */
 sessions(): Promise<ReadResult<readonly SessionSummary[]>>;
 /** Revokes another session. A 401 is disambiguated through a view-only read. */
 revokeSibling(id: SessionId, key: DeviceKey): Promise<RevokeResult>;
 /** Best-effort self-revoke, then forget the saved session. If another tab stored a newer record, that record is adopted instead. */
 signOut(): Promise<void>;
 /** Reads a request in any state. A view-token 401 ends this session. */
 inspect(id: RequestId): Promise<ReadResult<Request>>;
 /** Sends sequentially. Execution success exists only after a confirming read. */
 approve(ids: readonly RequestId[], key: DeviceKey): Promise<ApprovalReport>;
 /** Clears a finished run. Running approval progress cannot be dismissed. */
 dismissApproval(): void;
 /** Denies sequentially without a key or JSON request body. */
 deny(ids: readonly RequestId[]): Promise<DenyReport>;
}

/** Creates a DOM-independent actor. No network call occurs before a method or subscription. */
export function createHandkey(options: { persistence?: Persistence; environment?: Environment } = {}): Handkey {
 const environment = options.environment ?? defaultEnvironment();
 const persistence = options.persistence ?? memoryPersistence();
 const broker = createBroker(environment);
 let record: SessionRecord | null = null;
 let encoded: string | null = null;
 let restored = false;
 let epoch = 0;
 let snapshot: Snapshot = { kind: 'register', reason: 'never-registered', remembered: null, approval: null };
 let approvalGeneration = 0;
 const listeners = new Set<() => void>();
 const timers = new Set<unknown>();
 let stream: AbortController | null = null;
 let listAbort: AbortController | null = null;
 let retryTimer: unknown = null;
 let pollTimer: unknown = null;
 let heartbeatTimer: unknown = null;
 let deadlineTimer: unknown = null;
 let expiryTimer: unknown = null;
 let unsubscribeStorage: (() => void) | null = null;
 let unsubscribeVisibility: (() => void) | null = null;
 let suppressStorage = false;
 let flight: Promise<void> | null = null;
 let dirty = false;
 let batchBusy = false;
 let stopApproval: (()=>void) | null = null;
 let registering = false;
 let attempt = 0;
 let connectedBefore = false;
 const decidedIds = new Set<RequestId>();
 const localDeadlines = new Map<RequestId,number>();

 function publish(next: Snapshot): void {
  snapshot = Object.freeze(next);
  for (const listener of listeners) { try { listener(); } catch { /* One consumer cannot interrupt actor cleanup. */ } }
 }
 function schedule(callback: () => void, milliseconds: number): unknown {
  const handle = environment.setTimeout(() => { timers.delete(handle); callback(); }, Math.max(0, milliseconds));
  timers.add(handle);
  return handle;
 }
 function clear(handle: unknown): void {
  if (handle === null) return;
  environment.clearTimeout(handle);
  timers.delete(handle);
 }
 function stopFeed(): void {
  stream?.abort(); stream = null;
  listAbort?.abort(); listAbort = null; flight = null; dirty = false;
  for (const handle of timers) environment.clearTimeout(handle);
  timers.clear();
  retryTimer = pollTimer = heartbeatTimer = deadlineTimer = expiryTimer = null;
 }
 function current(captured: number): boolean { return captured === epoch && record !== null; }
 function swap(next: string | null): 'saved' | 'superseded' | 'failed' {
  suppressStorage = true;
  try {
   if (!persistence.compareAndSwap(encoded, next)) return 'superseded';
   encoded = next;
   return 'saved';
  } catch { return 'failed'; }
  finally { suppressStorage = false; }
 }
 function end(reason: Extract<Snapshot, {kind:'register'}>['reason'], captured: number): void {
  if (!current(captured)) return;
  const remembered = record === null ? null : { brokerUrl: record.brokerUrl, deviceId: record.deviceId };
  stopApproval?.();
  const approval = snapshot.approval;
  ++epoch; stopFeed(); record = null; dirty = false; flight = null;
  const result = swap(null);
  if (result === 'superseded') { restore(); return; }
  publish({ kind: 'register', reason, remembered, approval });
 }
 function armLocal(): void {
  clear(deadlineTimer); clear(expiryTimer);
  if (listeners.size === 0 || record === null || snapshot.kind !== 'active') return;
  const captured = epoch;
  expiryTimer = schedule(() => { end('expired', captured); }, record.viewUntil - environment.now());
  const deadlines = snapshot.pending.flatMap(request=>{
   const deadline=localDeadlines.get(request.id);return deadline===undefined?[]:[deadline];
  });
  if (deadlines.length > 0) deadlineTimer = schedule(() => {
   if (!current(captured) || snapshot.kind !== 'active') return;
   publish({ ...snapshot, pending: snapshot.pending.filter(request => {
    const deadline=localDeadlines.get(request.id);return deadline===undefined || deadline>environment.now();
   }) });
   armLocal();
  }, Math.min(...deadlines) - environment.now());
 }
 function adopt(next: SessionRecord, start = true): void {
  ++epoch; stopFeed(); record = next; flight = null; dirty = false; attempt = 0; connectedBefore = false; decidedIds.clear(); localDeadlines.clear();
  if (next.viewUntil <= environment.now()) { end('expired', epoch); return; }
  publish({ kind: 'active', session: { brokerUrl: next.brokerUrl, deviceId: next.deviceId, sessionId: next.sessionId, viewUntil: next.viewUntil },
   pending: [], unreadable: 0, list: {kind:'loading'}, connection:'connecting', approval:snapshot.approval });
  if (start && listeners.size > 0) { armLocal(); connect(); }
 }
 function restore(): void {
  let saved: string | null;
  try { saved = persistence.read(); } catch { saved = null; }
  if (restored && saved === encoded) return;
  restored = true;
  encoded = saved;
  if (saved === null) {
   const remembered = record === null ? null : { brokerUrl: record.brokerUrl, deviceId: record.deviceId };
   ++epoch; stopFeed(); record = null; flight = null; dirty = false;
   publish({kind:'register',reason: remembered === null ? 'never-registered' : 'signed-out',remembered,approval:snapshot.approval});
   return;
  }
  const parsed = parseSavedSession(saved);
  if (parsed.kind === 'protocol') {
   ++epoch; stopFeed(); record = null; swap(null);
   publish({kind:'register',reason:'invalid-saved-session',remembered:null,approval:snapshot.approval});
   return;
  }
  adopt(parsed.value);
 }
 async function view<T>(input: { call: () => Promise<Reply<T>>; captured: number }): Promise<ReadResult<T>> {
  const reply = await input.call();
  if (!current(input.captured)) return {kind:'session-ended'};
  switch (reply.kind) {
   case 'ok': return reply;
   case 'unauthorized': end('rejected', input.captured); return {kind:'session-ended'};
   case 'not-found': return reply;
   case 'failed': return reply;
   case 'conflict': return {kind:'failed',fault:{kind:'protocol'}};
   default: { const unreachable: never = reply; return unreachable; }
  }
 }
 async function refresh(): Promise<void> {
  if (record === null) return;
  if (flight !== null) { dirty = true; return flight; }
  const session = record;
  const captured = epoch;
  const controller = new AbortController(); listAbort = controller;
  const run = async (): Promise<void> => {
   do {
    dirty = false;
    const result = await view({ call: () => broker.pending(session, controller.signal), captured });
    if (controller.signal.aborted) return;
    if (!current(captured) || snapshot.kind !== 'active') return;
    if (result.kind === 'ok') {
     const fetchedAt=environment.now();
     const pending = result.value.requests.filter(request => !decidedIds.has(request.id));
     localDeadlines.clear();
     // Nonpositive observed lifetimes may mean clock skew. Only a later broker list removes those entries.
     for(const request of pending) if(request.deadline>fetchedAt) localDeadlines.set(request.id,request.deadline);
     publish({...snapshot,pending,unreadable:result.value.unreadable,list:{kind:'fresh',checkedAt:toInstant(environment.now())}});
     armLocal();
    } else if (result.kind === 'failed' || result.kind === 'not-found') {
     const lastCheckedAt = snapshot.list.kind === 'fresh' ? snapshot.list.checkedAt : snapshot.list.kind === 'stale' ? snapshot.list.lastCheckedAt : null;
     publish({...snapshot,list:{kind:'stale',lastCheckedAt,fault:result.kind === 'failed' ? result.fault : {kind:'protocol'}}});
    }
   } while (dirty && current(captured));
  };
  flight = run().finally(() => {
   if (listAbort === controller) { listAbort = null; flight = null; }
  });
  return flight;
 }
 function reconcile(input: {captured: number; ids: readonly RequestId[]}): void {
  if (!current(input.captured) || snapshot.kind !== 'active') return;
  for (const id of input.ids) decidedIds.add(id);
  if (input.ids.length > 0) {
   publish({...snapshot,pending:snapshot.pending.filter(request=>!decidedIds.has(request.id))});
   armLocal();
  }
  void refresh();
 }
 function down(captured: number): void {
  if (!current(captured) || listeners.size === 0 || snapshot.kind !== 'active') return;
  publish({...snapshot,connection:'retrying'});
  if (pollTimer === null) pollTimer = schedule(function poll() {
   pollTimer = null;
   if (!current(captured) || listeners.size === 0) return;
   void refresh();
   pollTimer = schedule(poll, 60_000);
  }, 60_000);
  const delay = Math.min(30_000, 1000 * 2 ** Math.min(attempt++, 20)) * Math.max(0, Math.min(1, environment.random()));
  retryTimer = schedule(() => { retryTimer = null; connect(); }, delay);
 }
 function connect(): void {
  if (record === null || listeners.size === 0 || stream !== null) return;
  const session = record; const captured = epoch;
  const controller = new AbortController(); stream = controller;
  let liveSince: number | null = null;
  if (connectedBefore) void refresh();
  connectedBefore = true;
  heartbeatTimer = schedule(() => { controller.abort(); },25_000);
  const activity = (): void => {
   if (liveSince !== null && environment.now() - liveSince >= 30_000) attempt = 0;
   clear(heartbeatTimer);
   heartbeatTimer = schedule(() => { controller.abort(); },25_000);
  };
  void (async () => {
   const result = await broker.events({session,signal:controller.signal});
   if (!current(captured) || listeners.size === 0 || controller.signal.aborted) return;
   if (result.kind === 'unauthorized') { end('rejected',captured); return; }
   if (result.kind !== 'ok') return;
   activity();
   await readEvents({stream:result.value,signal:controller.signal,onFrame(kind) {
    if (!current(captured) || listeners.size === 0) return;
    activity();
    switch (kind) {
     case 'sync':
      liveSince ??= environment.now(); clear(pollTimer); pollTimer = null;
      if (snapshot.kind === 'active') publish({...snapshot,connection:'live'});
      void refresh(); break;
     case 'change': void refresh(); break;
     case 'heartbeat': break;
     default: { const unreachable: never = kind; return unreachable; }
    }
   }});
  })().catch(() => {}).finally(() => {
   if (stream !== controller) return;
   stream = null; clear(heartbeatTimer); heartbeatTimer = null;
   down(captured);
  });
 }
 const subscribe = (listener: () => void): (() => void) => {
  const subscription = (): void => { listener(); };
  listeners.add(subscription);
  if (listeners.size === 1) {
   unsubscribeStorage = persistence.subscribe?.(() => { if (!suppressStorage) restore(); }) ?? null;
   unsubscribeVisibility = environment.visibility?.subscribe(() => {
    if (environment.visibility?.isVisible()) void refresh();
   }) ?? null;
   restore(); armLocal(); connect();
  }
  let subscribed = true;
  return () => {
   if (!subscribed) return;
   subscribed = false; listeners.delete(subscription);
   if (listeners.size === 0) { stopFeed(); unsubscribeStorage?.(); unsubscribeStorage = null; unsubscribeVisibility?.(); unsubscribeVisibility = null; }
  };
 };
 const keyTarget = (input: {brokerUrl:string;deviceId:string}): {kind:'ok';brokerUrl:string} | {kind:'invalid-broker-url'} | {kind:'invalid-device-id'} => {
  const brokerUrl = normalizeBrokerUrl(input.brokerUrl);
  if (brokerUrl === null) return {kind:'invalid-broker-url'};
  if (input.deviceId.length === 0) return {kind:'invalid-device-id'};
  return {kind:'ok',brokerUrl};
 };
 const keyFailure = <T>(reply: Exclude<Reply<T>,{kind:'ok'}>): {kind:'rejected'} | {kind:'not-found'} | {kind:'failed';fault:Fault} => {
  switch(reply.kind) {
   case 'unauthorized': return {kind:'rejected'};
   case 'not-found': return reply;
   case 'failed': return reply;
   case 'conflict': return {kind:'failed',fault:{kind:'protocol'}};
   default: {const unreachable:never = reply; return unreachable;}
  }
 };
 restore();
 return {
  subscribe, getSnapshot: () => snapshot, refresh,
  async register(input) {
   const bytes = claimKey(input.key);
   if (bytes === null) return {kind:'key-spent'};
   let ownsRegistration = false;
   try {
    if (batchBusy || registering) return {kind:'busy'};
    const target = keyTarget(input);
    if (target.kind !== 'ok') return target;
    if ([...input.name].length > 128 || /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(input.name)) return {kind:'invalid-name'};
    registering = true; ownsRegistration = true;
    const startedFrom = encoded;
    const previous = record;
    const reply = await broker.createSession({brokerUrl:target.brokerUrl,deviceId:input.deviceId,name:input.name,bytes});
    bytes.fill(0);
    switch(reply.kind) {
     case 'unauthorized': return {kind:'rejected'};
     case 'conflict': return {kind:'session-limit'};
     case 'not-found': return {kind:'failed',fault:{kind:'protocol'}};
     case 'failed': return reply;
     case 'ok': {
      let stored: string | null;
      try {stored=persistence.read();} catch {
       await broker.revoke({session:reply.value,id:reply.value.sessionId});
       return {kind:'failed',fault:{kind:'storage'}};
      }
      if(stored!==null && stored!==startedFrom) {
       restore();await broker.revoke({session:reply.value,id:reply.value.sessionId});
       return {kind:'registered',persistence:'superseded'};
      }
      encoded=stored;
      const saved = swap(encodeSavedSession(reply.value));
      if (saved === 'superseded') {
       restore();
       await broker.revoke({session:reply.value,id:reply.value.sessionId});
      } else {
       adopt(reply.value,false);
       const replacementEpoch=epoch;
       if(previous!==null && stored!==null) await broker.revoke({session:previous,id:previous.sessionId});
       if(current(replacementEpoch) && listeners.size>0){armLocal();connect();}
      }
      return {kind:'registered',persistence:saved};
     }
     default: {const unreachable:never=reply; return unreachable;}
    }
   } finally {bytes.fill(0); if (ownsRegistration) registering = false;}
  },
  async listSessionsWithKey(input) {
   const bytes = claimKey(input.key);
   if (bytes === null) return {kind:'key-spent'};
   try {
    const target = keyTarget(input); if (target.kind !== 'ok') return target;
    const reply = await broker.keySessions({brokerUrl:target.brokerUrl,deviceId:input.deviceId,bytes});
    if (reply.kind === 'ok') return reply;
    const failed = keyFailure(reply);
    return failed.kind === 'not-found' ? {kind:'failed',fault:{kind:'protocol'}} : failed;
   } finally {bytes.fill(0);}
  },
  async revokeSessionWithKey(input) {
   const bytes = claimKey(input.key);
   if (bytes === null) return {kind:'key-spent'};
   try {
    const target = keyTarget(input); if (target.kind !== 'ok') return target;
    const reply = await broker.keyRevoke({brokerUrl:target.brokerUrl,deviceId:input.deviceId,sessionId:input.sessionId,bytes});
    return reply.kind === 'ok' ? {kind:'ok'} : keyFailure(reply);
   } finally {bytes.fill(0);}
  },
  sessions() {
   const session = record; if (session === null) return Promise.resolve({kind:'not-registered'});
   return view({call:()=>broker.sessions(session),captured:epoch});
  },
  inspect(id) {
   const session = record; if (session === null) return Promise.resolve({kind:'not-registered'});
   return view({call:()=>broker.request({session,id}),captured:epoch});
  },
  async revokeSibling(id,key) {
   const bytes = claimKey(key);
   if (bytes === null) return {kind:'key-spent'};
   try {
    const session = record; if (session === null) return {kind:'not-registered'};
    const captured = epoch;
    const reply = await broker.revoke({session,id,bytes});
    bytes.fill(0);
    if (!current(captured)) return {kind:'session-ended'};
    switch(reply.kind) {
     case 'ok': return {kind:'ok'};
     case 'not-found': return reply;
     case 'failed': return reply;
     case 'conflict': return {kind:'failed',fault:{kind:'protocol'}};
     case 'unauthorized': {
      const check = await view({call:()=>broker.sessions(session),captured});
      if (check.kind === 'session-ended') return check;
      if (check.kind === 'ok' || check.kind === 'not-found') return {kind:'key-rejected'};
      return {kind:'auth-undetermined'};
     }
     default: {const unreachable:never=reply; return unreachable;}
    }
   } finally {bytes.fill(0);}
  },
  async signOut() {
   if (stopApproval !== null) stopApproval();
   else { ++approvalGeneration; publish({...snapshot,approval:null}); }
   const session = record; if (session === null) return;
   const captured = epoch;
   await broker.revoke({session,id:session.sessionId});
   end('signed-out',captured);
  },
  async approve(ids,key) {
   const bytes = claimKey(key);
   if (bytes === null) return {kind:'key-spent'};
   let ownsBatch = false;
   try {
    if (batchBusy || registering) return {kind:'busy'};
    const session = record; if (session === null || snapshot.kind !== 'active') return {kind:'not-registered'};
    if (ids.length === 0) return {kind:'empty'};
    batchBusy = true; ownsBatch = true;
    const captured = epoch;
    const generation = ++approvalGeneration;
    let run = startRun(ids.map(id=>({id,request:snapshot.kind === 'active' ? snapshot.pending.find(request=>request.id === id) ?? null : null})));
    const emit = (): void => {if(generation === approvalGeneration) publish({...snapshot,approval:run});};
    const step = (id:RequestId,value:ApprovalStep):void => {run=withStep({run,id,step:value});emit();};
    const cancelled=():boolean=>run.stopped==='session-ended';
    stopApproval=()=>{bytes.fill(0);run=stopRun(run,'session-ended');};
    emit();
    for (const item of run.items) {
     if (item.step.kind === 'done') continue;
     if (!current(captured) || cancelled()) {run=stopRun(run,'session-ended');emit();break;}
     step(item.id,{kind:'approving',since:toInstant(environment.now())});
     if (!current(captured) || cancelled()) {
      step(item.id,{kind:'done',outcome:{kind:'not-sent',because:'batch-stopped'}});
      run=stopRun(run,'session-ended');emit();break;
     }
     const reply = await broker.approve({session,id:item.id,bytes});
     const next = afterApprove(reply);
     if(next.stop || !run.items.some(other=>other.id!==item.id && other.step.kind==='queued')) bytes.fill(0);
     let stop: StopReason | null = null;
     let outcome;
     switch(next.kind) {
      case 'missing': outcome={kind:'not-found',request:null} satisfies import('./approval.js').ApprovalOutcome;stop='not-found';break;
      case 'confirm': case 'decided': case 'authenticate': case 'interrupted': {
       step(item.id,{kind:'confirming',since:toInstant(environment.now())});
       const checked = await broker.request({session,id:item.id});
       if (checked.kind === 'unauthorized') end('rejected',captured);
       switch(next.kind) {
        case 'confirm': outcome=settleConfirmed(checked);break;
        case 'decided': outcome={kind:'already-decided',request:checked.kind === 'ok' ? checked.value : null} satisfies import('./approval.js').ApprovalOutcome;break;
        case 'authenticate': outcome=settleUnauthorized(checked);stop=outcomeStop(outcome);break;
        case 'interrupted': outcome=settleInterrupted(checked);stop='interrupted';break;
        default: {const unreachable:never=next; throw new Error('Unreachable approval transition');}
       }
       break;
      }
      default: {const unreachable:never=next; throw new Error('Unreachable approval transition');}
     }
     step(item.id,{kind:'done',outcome});
     if (!current(captured) || cancelled()) stop='session-ended';
     if (stop !== null) {run=stopRun(run,stop);emit();break;}
    }
    emit();
    const report = reportOf(run);
     if (report.stopped !== 'session-ended' && report.items.some(item=>item.outcome.kind!=='not-sent')) reconcile({captured,ids:report.items.filter(item=>{
      switch(item.outcome.kind) {
       case 'executed': case 'execution-failed': case 'already-decided': case 'not-found': return true;
       case 'outcome-unknown': return item.outcome.request?.approval.kind === 'approved';
       case 'interrupted': case 'key-rejected': case 'auth-undetermined': case 'session-ended': case 'not-sent': return false;
       default: {const exhaustive:never=item.outcome;return exhaustive;}
      }
     }).map(item=>item.id)});
     return report;
   } finally {bytes.fill(0);if (ownsBatch) {batchBusy=false;stopApproval=null;}}
  },
  dismissApproval() {if(snapshot.approval?.kind === 'finished') { ++approvalGeneration; publish({...snapshot,approval:null}); }},
  async deny(ids) {
   if(batchBusy) return {kind:'busy'};
   const session=record;if(session===null)return {kind:'not-registered'};
   const captured=epoch;
   const items: {id:RequestId;outcome:DenyOutcome}[]=[];
   let stopped: 'session-ended'|'not-found'|'interrupted'|null=null;
   for(const id of new Set(ids)) {
    if(stopped!==null) {items.push({id,outcome:{kind:'not-sent'}});continue;}
    if(!current(captured)){stopped='session-ended';items.push({id,outcome:{kind:'session-ended'}});continue;}
    const reply=await broker.deny({session,id});
    switch(reply.kind){
     case 'ok':items.push({id,outcome:{kind:'denied'}});break;
     case 'conflict':items.push({id,outcome:{kind:'already-decided'}});break;
     case 'unauthorized':end('rejected',captured);stopped='session-ended';items.push({id,outcome:{kind:'session-ended'}});break;
     case 'not-found':stopped='not-found';items.push({id,outcome:{kind:'not-found'}});break;
     case 'failed':stopped='interrupted';items.push({id,outcome:{kind:'interrupted'}});break;
     default:{const unreachable:never=reply;return unreachable;}
    }
   }
   if (stopped !== 'session-ended') reconcile({captured,ids:items.filter(item=>{
     switch(item.outcome.kind) {
      case 'denied': case 'already-decided': case 'not-found': return true;
      case 'interrupted': case 'session-ended': case 'not-sent': return false;
      default: {const exhaustive:never=item.outcome;return exhaustive;}
     }
    }).map(item=>item.id)});
    return {kind:'finished',items,stopped};
  },
 };
}
