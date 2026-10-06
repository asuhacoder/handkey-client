import { describe, expect, it } from 'vitest';
import { createHandkey } from '../src/handkey.js';
import type { Environment, Persistence } from '../src/environment.js';
import { memoryPersistence } from '../src/environment.js';
import { aborting, created, deferred, fakeEnvironment, flush, json, key, request, savedPersistence, TOKEN, URL_BASE } from './helpers.js';
import type { FetchCall } from './helpers.js';

const NEW_TOKEN = 'new-view-token';
type Route = (call: FetchCall) => Response | Promise<Response> | undefined;

/** Routes by URL and token instead of arrival order, so a fix may reorder its requests freely. */
function routed(route: Route) {
 const fake = fakeEnvironment();
 const calls: FetchCall[] = [];
 const fetch: typeof globalThis.fetch = async (input, init) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  const call: FetchCall = { url, method: init?.method ?? 'GET', headers: new Headers(init?.headers), body: init?.body, signal: init?.signal, init };
  calls.push(call);
  const reply = route(call);
  if (reply === undefined) throw new Error(`Unexpected fetch ${call.method} ${url}`);
  return reply;
 };
 const environment: Environment = { ...fake.environment, fetch };
 return { environment, calls, fake };
}
const path = (call: FetchCall) => call.url.slice(URL_BASE.length);
const token = (call: FetchCall) => call.headers.get('Authorization')?.replace('Bearer ', '') ?? null;
const sent = (calls: readonly FetchCall[], method: string, suffix: string) => calls.filter(call => call.method === method && path(call) === suffix);
const registration = () => ({ brokerUrl: URL_BASE, deviceId: 'device', name: 'Laptop', key: key() });
function stored(persistence: Persistence): unknown {
 const text = persistence.read();
 return text === null ? null : JSON.parse(text);
}

describe('review regressions', () => {
 it('1a keeps the invalid-saved-session reason when the first subscriber arrives', () => {
  const persistence = memoryPersistence();
  persistence.compareAndSwap(null, 'not a session record');
  const { environment } = routed(() => undefined);
  const actor = createHandkey({ environment, persistence });
  expect(actor.getSnapshot()).toEqual({ kind: 'register', reason: 'invalid-saved-session', remembered: null, approval: null });
  const unsubscribe = actor.subscribe(() => {});
  expect(actor.getSnapshot()).toEqual({ kind: 'register', reason: 'invalid-saved-session', remembered: null, approval: null });
  unsubscribe();
 });

 it('1b keeps signed-out and the remembered device across a remount', async () => {
  const persistence = savedPersistence();
  const { environment } = routed(call => {
   if (path(call) === '/v1/sessions/session/revoke') return json({ status: 'revoked' });
   if (path(call) === '/v1/requests') return json([]);
   return aborting(call);
  });
  const actor = createHandkey({ environment, persistence });
  const first = actor.subscribe(() => {});
  await flush();
  await actor.signOut();
  const signedOut = { kind: 'register', reason: 'signed-out', remembered: { brokerUrl: URL_BASE, deviceId: 'device' }, approval: null };
  expect(actor.getSnapshot()).toEqual(signedOut);
  first();
  const second = actor.subscribe(() => {});
  expect(actor.getSnapshot()).toEqual(signedOut);
  second();
 });

 it('1c completes a registration that was in flight when the first subscriber arrived', async () => {
  const persistence = memoryPersistence();
  const creation = deferred<Response>();
  const { environment, calls } = routed(call => {
   if (call.method === 'POST' && path(call) === '/v1/devices/device/sessions') return creation.promise;
   if (path(call) === '/v1/requests' && token(call) === NEW_TOKEN) return json([]);
   if (path(call) === '/v1/events' && token(call) === NEW_TOKEN) return aborting(call);
   return undefined;
  });
  const actor = createHandkey({ environment, persistence });
  const registering = actor.register(registration());
  await flush();
  const unsubscribe = actor.subscribe(() => {});
  creation.resolve(json(created('new', NEW_TOKEN)));
  expect(await registering).toEqual({ kind: 'registered', persistence: 'saved' });
  const snapshot = actor.getSnapshot();
  expect(snapshot.kind === 'active' ? snapshot.session.sessionId : snapshot).toBe('new');
  expect(stored(persistence)).toMatchObject({ sessionId: 'new', viewToken: NEW_TOKEN });
  expect(calls.filter(call => path(call).endsWith('/revoke'))).toEqual([]);
  unsubscribe();
 });

 it('3 survives a late 401 for the old session while its self-revoke is in flight', async () => {
  const persistence = savedPersistence();
  const oldList = deferred<Response>();
  const oldRevoke = deferred<Response>();
  const { environment, calls } = routed(call => {
   if (call.method === 'POST' && path(call) === '/v1/devices/device/sessions') return json(created('new', NEW_TOKEN));
   if (path(call) === '/v1/sessions/session/revoke') return oldRevoke.promise;
   if (path(call) === '/v1/requests') return token(call) === TOKEN ? oldList.promise : json([]);
   if (path(call) === '/v1/events') return aborting(call);
   return undefined;
  });
  const actor = createHandkey({ environment, persistence });
  const unsubscribe = actor.subscribe(() => {});
  void actor.refresh();
  await flush();
  expect(sent(calls, 'GET', '/v1/requests').filter(call => token(call) === TOKEN)).toHaveLength(1);
  const registering = actor.register(registration());
  await flush();
  oldList.resolve(new Response('', { status: 401 }));
  await flush();
  oldRevoke.resolve(json({ status: 'revoked' }));
  expect(await registering).toEqual({ kind: 'registered', persistence: 'saved' });
  await flush();
  const snapshot = actor.getSnapshot();
  expect(snapshot.kind === 'active' ? snapshot.session.sessionId : snapshot).toBe('new');
  expect(stored(persistence)).toMatchObject({ sessionId: 'new', viewToken: NEW_TOKEN });
  expect(sent(calls, 'POST', '/v1/sessions/session/revoke')).toHaveLength(1);
  expect(sent(calls, 'POST', '/v1/sessions/new/revoke')).toEqual([]);
  unsubscribe();
 });

 it('4 lists again after a synchronous unsubscribe and resubscribe during a list', async () => {
  const persistence = savedPersistence();
  let lists = 0;
  const { environment } = routed(call => {
   if (path(call) === '/v1/requests') return ++lists === 1 ? aborting(call) : json([]);
   if (path(call) === '/v1/events') return aborting(call);
   return undefined;
  });
  const actor = createHandkey({ environment, persistence });
  const first = actor.subscribe(() => {});
  void actor.refresh();
  await flush();
  expect(lists).toBe(1);
  first();
  const second = actor.subscribe(() => {});
  await actor.refresh();
  await flush();
  const snapshot = actor.getSnapshot();
  expect(snapshot.kind === 'active' ? snapshot.list.kind : snapshot).toBe('fresh');
  expect(lists).toBeGreaterThanOrEqual(2);
  second();
 });

 it('5 keeps the feed while one of two subscriptions of the same listener is held', async () => {
  const persistence = savedPersistence();
  const { environment, calls } = routed(call => {
   if (path(call) === '/v1/requests') return json([]);
   if (path(call) === '/v1/events') return aborting(call);
   return undefined;
  });
  const actor = createHandkey({ environment, persistence });
  const listener = () => {};
  const first = actor.subscribe(listener);
  const second = actor.subscribe(listener);
  await flush();
  const streams = sent(calls, 'GET', '/v1/events');
  expect(streams).toHaveLength(1);
  first();
  await flush();
  expect(streams[0]?.signal?.aborted).toBe(false);
  first();
  await flush();
  expect(streams[0]?.signal?.aborted).toBe(false);
  second();
  await flush();
  expect(streams[0]?.signal?.aborted).toBe(true);
 });

 it('6 reports busy and spends the key when approve is called during a registration', async () => {
  const persistence = savedPersistence();
  const creation = deferred<Response>();
  const { environment, calls } = routed(call => {
   if (call.method === 'POST' && path(call) === '/v1/devices/device/sessions') return creation.promise;
   if (path(call).endsWith('/revoke')) return json({ status: 'revoked' });
   if (path(call) === '/v1/requests') return json([]);
   if (path(call) === '/v1/events') return aborting(call);
   return undefined;
  });
  const actor = createHandkey({ environment, persistence });
  const unsubscribe = actor.subscribe(() => {});
  await flush();
  const registering = actor.register(registration());
  await flush();
  const approvalKey = key();
  const id = request('r1').id;
  expect(await actor.approve([id], approvalKey)).toEqual({ kind: 'busy' });
  expect(await actor.approve([id], approvalKey)).toEqual({ kind: 'key-spent' });
  expect(calls.filter(call => path(call).startsWith('/v1/requests/'))).toEqual([]);
  creation.resolve(json(created('new', NEW_TOKEN)));
  expect(await registering).toEqual({ kind: 'registered', persistence: 'saved' });
  unsubscribe();
 });
});
