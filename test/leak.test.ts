import { inspect } from 'node:util';
import { expect, test } from 'vitest';
import { consumeDeviceKey, createHandkey, memoryPersistence } from '../src/index.js';
import type { DeviceKey, KeyRevokeResult, KeySessionsResult, Persistence, RegisterResult } from '../src/index.js';
import { aborting, created, deferred, fakeEnvironment, flush, json, KEY, request, savedPersistence, sessionId, sse, TOKEN, URL_BASE, wireRequest, wireSessions } from './helpers.js';

test('all key-taking routes keep credentials out of every public emission and result', async () => {
 const snapshots: string[] = [];
 const results: unknown[] = [];
 const persisted: (string | null)[] = [];
 const caught: unknown[] = [];
 const calls: ReturnType<typeof fakeEnvironment>['calls'] = [];
 const tokens = [TOKEN, `${TOKEN}-registered`];
 const serialize = (value: unknown) => [JSON.stringify(value), String(value), inspect(value, { depth: null })].join('\n');
 const credential = (): DeviceKey => {
  const value = consumeDeviceKey(KEY);
  if (value === null) throw new Error('Invalid key fixture');
  results.push(value);
  expect([String(value), JSON.stringify(value), inspect(value)]).toEqual(['[DeviceKey]', '"[DeviceKey]"', '[DeviceKey]']);
  return value;
 };
 const observe = async <T>(promise: Promise<T>): Promise<T> => {
  try {
   const value = await promise;
   results.push(value);
   return value;
  } catch (value) {
   caught.push(value);
   throw new Error('Public API unexpectedly rejected');
  }
 };
 const scenario = (registered = true) => {
  const fake = fakeEnvironment();
  const backing = registered ? savedPersistence() : memoryPersistence();
  const persistence: Persistence = {
   read() { const value = backing.read(); persisted.push(value); return value; },
   compareAndSwap(expected, next) {
    persisted.push(expected, next);
    return backing.compareAndSwap(expected, next);
   },
   subscribe(listener) { return backing.subscribe?.(listener) ?? (() => {}); },
  };
  const feed = sse();
  if (registered) fake.queue(feed.response);
  const actor = createHandkey({ environment: fake.environment, persistence });
  snapshots.push(serialize(actor.getSnapshot()));
  const stop = actor.subscribe(() => { snapshots.push(serialize(actor.getSnapshot())); });
  const finish = async () => {
   persisted.push(persistence.read());
   snapshots.push(serialize(actor.getSnapshot()));
   stop();
   await flush();
   expect(fake.timers.size).toBe(0);
   expect(fake.replies).toEqual([]);
   calls.push(...fake.calls);
  };
  const timeout = async () => {
   await flush();
   for (let i = 0; i < 7; ++i) {
    feed.push(': heartbeat\n\n');
    await flush();
    await fake.advance(20_000);
   }
   feed.push(': heartbeat\n\n');
   await flush();
   await fake.advance(10_000);
  };
  return { fake, actor, persistence, feed, finish, timeout };
 };
 const target = { brokerUrl: URL_BASE, deviceId: 'device' };
 const one = request('r1').id;
 const two = request('r2').id;
 const sibling = sessionId();
 const failure = (status: number) => status === -1 ? new Error(`transport ${KEY} ${TOKEN}`) : status === -2 ? aborting : json({ error: `${KEY} ${TOKEN}` }, status);

 for (const row of [
  { status: 201, expected: { kind: 'registered', persistence: 'saved' } },
  { status: 401, expected: { kind: 'rejected' } },
  { status: 409, expected: { kind: 'session-limit' } },
  { status: 500, expected: { kind: 'failed', fault: { kind: 'unavailable' } } },
  { status: -1, expected: { kind: 'failed', fault: { kind: 'network' } } },
 ]) {
  const s = scenario();
  await flush();
  if (row.status === 201) s.fake.queue(json(created('registered', tokens[1]), 201), json({ status: 'revoked' }), sse().response);
  else s.fake.queue(failure(row.status));
  const key = credential();
  expect(await observe(s.actor.register({ ...target, name: 'Laptop', key }))).toEqual(row.expected);
  expect(await observe(s.actor.register({ ...target, name: 'Laptop', key }))).toEqual({ kind: 'key-spent' });
  if (row.status === 201) {
   const snapshot = s.actor.getSnapshot();
   expect(snapshot.kind === 'active' ? snapshot.session.sessionId : null).toBe('registered');
   expect(s.persistence.read()).toContain(`${TOKEN}-registered`);
  }
  await s.finish();
 }

 const approvalRows = [
  { label: '200 ready', post: 200, get: 200, approval: 'approved', execution: 'ready', outcome: 'executed', stop: null },
  { label: '409 decided', post: 409, get: 200, approval: 'denied', execution: 'not_started', outcome: 'already-decided', stop: null },
  { label: '401 GET401', post: 401, get: 401, approval: 'pending', execution: 'not_started', outcome: 'session-ended', stop: 'session-ended' },
  { label: '401 GET200', post: 401, get: 200, approval: 'pending', execution: 'not_started', outcome: 'key-rejected', stop: 'key-rejected' },
  { label: '401 GET404', post: 401, get: 404, approval: 'pending', execution: 'not_started', outcome: 'key-rejected', stop: 'key-rejected' },
  { label: '401 GET500', post: 401, get: 500, approval: 'pending', execution: 'not_started', outcome: 'auth-undetermined', stop: 'auth-undetermined' },
  { label: '404', post: 404, get: 0, approval: 'pending', execution: 'not_started', outcome: 'not-found', stop: 'not-found' },
  { label: '503 GETapproved', post: 503, get: 200, approval: 'approved', execution: 'ready', outcome: 'executed', stop: 'interrupted' },
  { label: '500 GETdenied', post: 500, get: 200, approval: 'denied', execution: 'not_started', outcome: 'already-decided', stop: 'interrupted' },
  { label: 'network GETpending', post: -1, get: 200, approval: 'pending', execution: 'not_started', outcome: 'interrupted', stop: 'interrupted' },
  { label: 'timeout GETpending', post: -2, get: 200, approval: 'pending', execution: 'not_started', outcome: 'interrupted', stop: 'interrupted' },
 ];
 for (const row of approvalRows) {
  const s = scenario();
  await flush();
  s.fake.queue(row.post === 200 ? json({ status: 'processed' }) : failure(row.post));
  if (row.get !== 0) s.fake.queue(row.get === 200 ? json(wireRequest('r1', row.approval, row.execution)) : failure(row.get));
  if (row.stop === null) s.fake.queue(json({ status: 'processed' }), json(wireRequest('r2', 'approved', 'ready')));
  if (row.stop !== 'session-ended') s.fake.queue(json([]));
  const key = credential();
  const pending = observe(s.actor.approve([one, two], key));
  const progress = s.actor.getSnapshot();
  expect(progress.kind === 'active' ? progress.approval?.items.map(item => item.step.kind) : null).toEqual(['approving', 'queued']);
  if (row.post === -2) await s.timeout();
  const report = await pending;
  expect(report.kind, row.label).toBe('finished');
  if (report.kind !== 'finished') throw new Error('Expected approval report');
  expect(report.items.map(item => item.outcome.kind), row.label).toEqual([row.outcome, row.stop === null ? 'executed' : 'not-sent']);
  expect(report.stopped, row.label).toBe(row.stop);
  expect(await observe(s.actor.approve([one], key))).toEqual({ kind: 'key-spent' });
  expect(s.fake.calls.slice(1).map(call => [call.method, new URL(call.url).pathname])).toEqual([
   ['POST', '/v1/requests/r1/approve'], ...(row.get === 0 ? [] : [['GET', '/v1/requests/r1']]),
   ...(row.stop === null ? [['POST', '/v1/requests/r2/approve'], ['GET', '/v1/requests/r2']] : []),
   ...(row.stop === 'session-ended' ? [] : [['GET', '/v1/requests']]),
  ]);
  if (row.stop === 'session-ended') {
   expect(s.actor.getSnapshot()).toEqual({ kind: 'register', reason: 'rejected', remembered: target });
   expect(s.persistence.read()).toBeNull();
  }
  s.actor.dismissApproval();
  await s.finish();
 }

 for (const row of [
  { post: 200, get: 0, expected: { kind: 'ok' } },
  { post: 404, get: 0, expected: { kind: 'not-found' } },
  { post: 503, get: 0, expected: { kind: 'failed', fault: { kind: 'unavailable' } } },
  { post: -1, get: 0, expected: { kind: 'failed', fault: { kind: 'network' } } },
  { post: 401, get: 200, expected: { kind: 'key-rejected' } },
  { post: 401, get: 401, expected: { kind: 'session-ended' } },
  { post: 401, get: 404, expected: { kind: 'key-rejected' } },
  { post: 401, get: 500, expected: { kind: 'auth-undetermined' } },
 ]) {
  const s = scenario();
  await flush();
  s.fake.queue(row.post === 200 ? json({ status: 'revoked' }) : failure(row.post));
  if (row.get !== 0) s.fake.queue(row.get === 200 ? json(wireSessions()) : failure(row.get));
  const key = credential();
  expect(await observe(s.actor.revokeSibling(sibling, key))).toEqual(row.expected);
  expect(await observe(s.actor.revokeSibling(sibling, key))).toEqual({ kind: 'key-spent' });
  await s.finish();
 }

 for (const method of ['list', 'revoke'] as const) {
  for (const status of [200, 401, 404, 409, 503, -1, -2]) {
   const s = scenario();
   await flush();
   s.fake.queue(status === 200 ? json(method === 'list' ? wireSessions() : { status: 'revoked' }) : failure(status));
   const key = credential();
   const run = (): Promise<KeySessionsResult | KeyRevokeResult> => method === 'list' ? s.actor.listSessionsWithKey({ ...target, key }) : s.actor.revokeSessionWithKey({ ...target, sessionId: sibling, key });
   const pending = observe(run());
   if (status === -2) await s.timeout();
   const result = await pending;
   if (status === 200 && method === 'list') {
    expect(result.kind).toBe('ok');
    if (result.kind !== 'ok' || !('value' in result)) throw new Error('Expected sessions');
    expect(result.value.map(value => [value.sessionId, value.name])).toEqual([['sibling', 'Phone <script>']]);
   } else {
    const expected = status === 200 ? { kind: 'ok' } : status === 401 ? { kind: 'rejected' }
     : status === 404 && method === 'revoke' ? { kind: 'not-found' }
     : { kind: 'failed', fault: { kind: status === -1 ? 'network' : status === -2 ? 'timeout' : status === 503 ? 'unavailable' : 'protocol' } };
    expect(result).toEqual(expected);
   }
   expect(await observe(run())).toEqual({ kind: 'key-spent' });
   const snapshot = s.actor.getSnapshot();
   expect(snapshot.kind === 'active' ? snapshot.session.sessionId : null).toBe('session');
   expect(s.fake.calls[1]?.headers.get('Authorization')).toBeNull();
   expect(s.fake.calls[1]?.body).toBe(JSON.stringify({ key: KEY }));
   await s.finish();
  }
 }

 for (const method of ['register', 'list', 'revoke'] as const) {
  for (const row of [
   { brokerUrl: 'invalid', deviceId: 'device', expected: 'invalid-broker-url' },
   { brokerUrl: URL_BASE, deviceId: '', expected: 'invalid-device-id' },
  ]) {
   const s = scenario(false);
   const key = credential();
   const run = (): Promise<RegisterResult | KeySessionsResult | KeyRevokeResult> => method === 'register' ? s.actor.register({ ...row, name: 'Laptop', key })
    : method === 'list' ? s.actor.listSessionsWithKey({ ...row, key })
    : s.actor.revokeSessionWithKey({ ...row, sessionId: sibling, key });
   expect(await observe(run())).toEqual({ kind: row.expected });
   expect(await observe(run())).toEqual({ kind: 'key-spent' });
   expect(s.fake.calls).toEqual([]);
   await s.finish();
  }
 }
 {
  const s = scenario(false);
  for (const name of ['x'.repeat(129), '\ud800']) {
   const key = credential();
   expect(await observe(s.actor.register({ ...target, name, key }))).toEqual({ kind: 'invalid-name' });
   expect(await observe(s.actor.register({ ...target, name: 'Laptop', key }))).toEqual({ kind: 'key-spent' });
  }
  const approvalKey = credential(), siblingKey = credential();
  expect(await observe(s.actor.approve([one], approvalKey))).toEqual({ kind: 'not-registered' });
  expect(await observe(s.actor.approve([one], approvalKey))).toEqual({ kind: 'key-spent' });
  expect(await observe(s.actor.revokeSibling(sibling, siblingKey))).toEqual({ kind: 'not-registered' });
  expect(await observe(s.actor.revokeSibling(sibling, siblingKey))).toEqual({ kind: 'key-spent' });
  expect(s.fake.calls).toEqual([]);
  await s.finish();
 }
 {
  const s = scenario();
  await flush();
  const empty = credential();
  expect(await observe(s.actor.approve([], empty))).toEqual({ kind: 'empty' });
  expect(await observe(s.actor.approve([], empty))).toEqual({ kind: 'key-spent' });
  const held = deferred<Response>();
  s.fake.queue(() => held.promise, json(wireRequest('r1', 'approved', 'ready')), json([]));
  const pending = observe(s.actor.approve([one], credential()));
  const busy = credential(), registerBusy = credential();
  expect(await observe(s.actor.approve([two], busy))).toEqual({ kind: 'busy' });
  expect(await observe(s.actor.approve([two], busy))).toEqual({ kind: 'key-spent' });
  expect(await observe(s.actor.register({ ...target, name: 'Laptop', key: registerBusy }))).toEqual({ kind: 'busy' });
  expect(await observe(s.actor.register({ ...target, name: 'Laptop', key: registerBusy }))).toEqual({ kind: 'key-spent' });
  held.resolve(json({ status: 'processed' }));
  const report = await pending;
  expect(report.kind === 'finished' ? report.items.map(item => item.outcome.kind) : null).toEqual(['executed']);
  await s.finish();
 }

 expect(caught).toEqual([]);
 for (const value of [...snapshots, ...results, ...persisted, ...caught]) expect(serialize(value)).not.toContain(KEY);
 for (const value of [...snapshots, ...results, ...caught]) {
  for (const token of tokens) expect(serialize(value)).not.toContain(token);
 }
 expect(persisted.some(value => value?.includes(TOKEN))).toBe(true);
 expect(persisted.some(value => value?.includes(`${TOKEN}-registered`))).toBe(true);
 expect(calls.some(call => call.headers.get('Authorization') === `Bearer ${TOKEN}`)).toBe(true);
 expect(calls.some(call => call.headers.get('Authorization') === `Bearer ${TOKEN}-registered`)).toBe(true);
 expect(calls.some(call => typeof call.body === 'string' && call.body.includes(KEY))).toBe(true);
 for (const call of calls) {
  expect(call.url).not.toContain(KEY);
  for (const token of tokens) {
   expect(call.url).not.toContain(token);
   expect(serialize(call.body)).not.toContain(token);
  }
  call.headers.forEach((value, name) => {
   expect(value).not.toContain(KEY);
   if (name !== 'authorization') for (const token of tokens) expect(value).not.toContain(token);
   else expect(tokens.map(token => `Bearer ${token}`)).toContain(value);
  });
  expect(call.headers.get('Content-Type')).toBe(call.body === undefined ? null : 'application/json');
  expect([call.init?.cache, call.init?.credentials, call.init?.redirect]).toEqual(['no-store', 'omit', 'error']);
 }
});
