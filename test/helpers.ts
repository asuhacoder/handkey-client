import type { Environment, Persistence } from '../src/environment.js';
import { memoryPersistence } from '../src/environment.js';
import { consumeDeviceKey } from '../src/key.js';
import { parseRequest, parseSessionList } from '../src/parse.js';

export const NOW = Date.UTC(2026, 0, 1);
export const KEY = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
export const TOKEN = 'private-view-token';
export const URL_BASE = 'https://broker.example';
export function key() {
 const value = consumeDeviceKey(KEY);
 if (value === null) throw new Error('Invalid key fixture');
 return value;
}
export function wireRequest(id = 'r1', approval = 'pending', execution = 'not_started', deadline = NOW + 300_000, method = 'otp') {
 return { id, spec: { method, reason: 'review this', agent: 'agent <script>' }, approval, execution,
  created_at: new Date(NOW - 1000).toISOString(), deadline: new Date(deadline).toISOString(), used: 0 };
}
export function request(id = 'r1', method = 'otp') {
 const result = parseRequest(wireRequest(id, 'pending', 'not_started', NOW + 300_000, method));
 if (result.kind !== 'ok') throw new Error('Invalid request fixture');
 return result.value;
}
export function wireSessions(id = 'sibling') {
 return [{ session_id: id, name: 'Phone <script>', created_at: new Date(NOW).toISOString(), view_until: new Date(NOW + 86_400_000).toISOString(), current: false }];
}
export function sessionId(id = 'sibling') {
 const result = parseSessionList(wireSessions(id));
 if (result.kind !== 'ok' || result.value[0] === undefined) throw new Error('Invalid session fixture');
 return result.value[0].sessionId;
}
export function created(id = 'session', token = TOKEN) {
 return { id: 'device', session_id: id, view_token: token, view_until: new Date(NOW + 86_400_000).toISOString() };
}
export function json(value: unknown, status = 200) { return new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } }); }
export function deferred<T>() {
 let resolve: (value: T) => void = () => { throw new Error('Uninitialized deferred'); };
 const promise = new Promise<T>(done => { resolve = done; });
 return { promise, resolve };
}
export async function flush() { for (let i = 0; i < 40; ++i) await Promise.resolve(); }
export interface FetchCall { url: string; method: string; headers: Headers; body: BodyInit | null | undefined; signal: AbortSignal | null | undefined; init: RequestInit | undefined }
type Reply = Response | Error | ((call: FetchCall) => Response | Promise<Response>);
export function fakeEnvironment() {
 let now = NOW;
 let visible = true;
 let nextTimer = 0;
 const timers = new Map<unknown, { at: number; callback: () => void }>();
 const visibilityListeners = new Set<() => void>();
 const calls: FetchCall[] = [];
 const replies: Reply[] = [];
 const fetch: typeof globalThis.fetch = async (input, init) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  const call = { url, method: init?.method ?? (input instanceof globalThis.Request ? input.method : 'GET'), headers: new Headers(init?.headers), body: init?.body, signal: init?.signal, init };
  calls.push(call);
  const reply = replies.shift();
  if (reply === undefined) throw new Error(`Unexpected fetch ${call.method} ${url}`);
  if (reply instanceof Error) throw reply;
  return typeof reply === 'function' ? reply(call) : reply;
 };
 const environment: Environment = {
  fetch, now: () => now, random: () => 1,
  setTimeout(callback, milliseconds): unknown { const handle = ++nextTimer; timers.set(handle, { at: now + milliseconds, callback }); return handle; },
  clearTimeout(handle: unknown) { timers.delete(handle); },
  visibility: { isVisible: () => visible, subscribe(callback) { visibilityListeners.add(callback); return () => { visibilityListeners.delete(callback); }; } },
 };
 return { environment, calls, timers, replies,
  queue(...values: Reply[]) { replies.push(...values); },
  async advance(milliseconds: number) {
   const until = now + milliseconds;
   for (;;) {
    const entry = [...timers].filter(([, timer]) => timer.at <= until).sort((a, b) => a[1].at - b[1].at)[0];
    if (entry === undefined) break;
    now = entry[1].at; timers.delete(entry[0]); entry[1].callback(); await flush();
   }
   now = until; await flush();
  },
  visibility(value: boolean) { visible = value; for (const callback of visibilityListeners) callback(); },
 };
}
export function sse() {
 let controller: ReadableStreamDefaultController<Uint8Array> | null = null;
 let closed = false;
 let cancelled = false;
 const stream = new ReadableStream<Uint8Array>({ start(value) { controller = value; }, cancel() { closed = true; cancelled = true; } });
 return { response: new Response(stream, { headers: { 'Content-Type': 'text/event-stream' } }),
  push(text: string) { if (controller === null || closed) throw new Error('Closed stream'); controller.enqueue(new TextEncoder().encode(text)); },
  close() { if (controller !== null && !closed) { closed = true; controller.close(); } },
  get cancelled() { return cancelled; },
 };
}
export function savedPersistence(id = 'session', token = TOKEN): Persistence {
 const persistence = memoryPersistence();
 persistence.compareAndSwap(null, JSON.stringify({ version: 1, brokerUrl: URL_BASE, deviceId: 'device', sessionId: id, viewToken: token, viewUntil: NOW + 86_400_000 }));
 return persistence;
}
export function aborting(call: FetchCall): Promise<Response> {
 return new Promise((_, reject) => { call.signal?.addEventListener('abort', () => { reject(new Error('sensitive transport diagnostic')); }, { once: true }); });
}
export function count(calls: readonly FetchCall[], suffix: string) { return calls.filter(call => call.url.endsWith(suffix)).length; }
