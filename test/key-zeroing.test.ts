import { afterEach, expect, test, vi } from 'vitest';
import { createHandkey } from '../src/handkey.js';
import { consumeDeviceKey } from '../src/key.js';
import { created, deferred, fakeEnvironment, flush, json, request, savedPersistence, sessionId, URL_BASE, wireRequest, wireSessions } from './helpers.js';

const SENTINEL_KEY = 'AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE';
const ZERO_BYTES = Array.from({ length: 32 }, () => 0);
const pendingRequest = {
 id: 'r1', agent: 'agent <script>', reason: 'review this', source: '', secrets: [],
 operation: { kind: 'otp' }, lease: { kind: 'single-use' }, cautions: [],
 createdAt: 1767225599000, deadline: 1767225900000,
 approval: { kind: 'pending' }, execution: { kind: 'not-started' },
 approvedAt: null, approvedBy: null, approvedSession: null, leaseUntil: null,
 used: 0, receiptUntil: null, createdItem: null,
};
const executedRequest = { ...pendingRequest, approval: { kind: 'approved' }, execution: { kind: 'ready' } };

function sentinelKey() {
 const key = consumeDeviceKey(SENTINEL_KEY);
 if (key === null) throw new Error('The nonzero key fixture must be canonical');
 return key;
}

function observeZeroing() {
 const originalFill = Uint8Array.prototype.fill;
 const buffers: Uint8Array[] = [];
 vi.spyOn(Uint8Array.prototype, 'fill').mockImplementation(function (this: Uint8Array, value: number, start?: number, end?: number) {
  const claimedKey = this.length === 32 && this.every(byte => byte === 1);
  const result = originalFill.call(this, value, start, end);
  if (claimedKey) buffers.push(this);
  return result;
 });
 return () => {
  expect(buffers).toHaveLength(1);
  for (const bytes of buffers) expect(Array.from(bytes)).toEqual(ZERO_BYTES);
 };
}

afterEach(() => { vi.restoreAllMocks(); });

type Operation = 'register' | 'listSessionsWithKey' | 'revokeSessionWithKey' | 'revokeSibling' | 'approve';
type Path = 'success' | 'guard' | 'http500' | 'thrown-fetch';
const operations: Operation[] = ['register', 'listSessionsWithKey', 'revokeSessionWithKey', 'revokeSibling', 'approve'];
const paths: Path[] = ['success', 'guard', 'http500', 'thrown-fetch'];
const cases = operations.flatMap(operation => paths.map(path => ({ operation, path })));

test.each(cases)('$operation zeroes its claimed nonzero bytes on $path', async ({ operation, path }) => {
 const fake = fakeEnvironment();
 const registered = path !== 'guard' && (operation === 'revokeSibling' || operation === 'approve');
 const actor = createHandkey({ environment: fake.environment, ...(registered ? { persistence: savedPersistence() } : {}) });
 if (operation === 'approve' && registered) {
  fake.queue(json([wireRequest()]));
  await actor.refresh();
 }
 const credential = sentinelKey();
 const assertZeroed = observeZeroing();
 const target = { brokerUrl: path === 'guard' ? 'not a URL' : URL_BASE, deviceId: 'device', key: credential };
 const failure = path === 'http500' ? json({}, 500) : new Error('fetch failed');
 const expectedFailure = { kind: 'failed', fault: { kind: path === 'http500' ? 'unavailable' : 'network' } };
 let result: unknown;
 let expected: unknown;
 switch (operation) {
  case 'register':
   if (path !== 'guard') fake.queue(path === 'success' ? json(created()) : failure);
   result = await actor.register({ ...target, name: 'Laptop' });
   expected = path === 'guard' ? { kind: 'invalid-broker-url' } : path === 'success' ? { kind: 'registered', persistence: 'saved' } : expectedFailure;
   break;
  case 'listSessionsWithKey':
   if (path !== 'guard') fake.queue(path === 'success' ? json(wireSessions()) : failure);
   result = await actor.listSessionsWithKey(target);
   expected = path === 'guard' ? { kind: 'invalid-broker-url' } : path === 'success'
    ? { kind: 'ok', value: [{ sessionId: 'sibling', name: 'Phone <script>', createdAt: 1767225600000, viewUntil: 1767312000000, current: false }] } : expectedFailure;
   break;
  case 'revokeSessionWithKey':
   if (path !== 'guard') fake.queue(path === 'success' ? json({ status: 'revoked' }) : failure);
   result = await actor.revokeSessionWithKey({ ...target, sessionId: sessionId() });
   expected = path === 'guard' ? { kind: 'invalid-broker-url' } : path === 'success' ? { kind: 'ok' } : expectedFailure;
   break;
  case 'revokeSibling':
   if (path !== 'guard') fake.queue(path === 'success' ? json({ status: 'revoked' }) : failure);
   result = await actor.revokeSibling(sessionId(), credential);
   expected = path === 'guard' ? { kind: 'not-registered' } : path === 'success' ? { kind: 'ok' } : expectedFailure;
   break;
  case 'approve':
   if (path !== 'guard') {
    fake.queue(path === 'success' ? json({ status: 'processed' }) : failure,
     path === 'success' ? json(wireRequest('r1', 'approved', 'ready')) : json({}, 500), json([]));
   }
   result = await actor.approve([request().id], credential);
   expected = path === 'guard' ? { kind: 'not-registered' } : {
    kind: 'finished', stopped: path === 'success' ? null : 'interrupted',
    items: [{ id: 'r1', request: pendingRequest, outcome: path === 'success'
     ? { kind: 'executed', request: executedRequest } : { kind: 'interrupted', request: null } }],
   };
   break;
  default: { const exhaustive: never = operation; throw new Error(`Unknown operation ${exhaustive}`); }
 }
 expect(result).toEqual(expected);
 assertZeroed();
 await flush();
 expect(fake.replies).toEqual([]);
 expect(fake.timers.size).toBe(0);
});

test('register zeroes bytes before waiting for previous session self-revoke', async () => {
 const fake = fakeEnvironment();
 const actor = createHandkey({ environment: fake.environment, persistence: savedPersistence('old-session') });
 const revoke = deferred<Response>();
 fake.queue(json(created('replacement')), () => revoke.promise);
 const credential = sentinelKey();
 const assertZeroed = observeZeroing();
 const operation = actor.register({ brokerUrl: URL_BASE, deviceId: 'device', name: 'Laptop', key: credential });
 await flush();
 expect(fake.calls.map(call => `${call.method} ${new URL(call.url).pathname}`)).toEqual([
  'POST /v1/devices/device/sessions', 'POST /v1/sessions/old-session/revoke',
 ]);
 try { assertZeroed(); }
 finally {
  revoke.resolve(json({ status: 'revoked' }));
  expect(await operation).toEqual({ kind: 'registered', persistence: 'saved' });
 }
 expect(fake.timers.size).toBe(0);
});

test('approve zeroes bytes before waiting for the final confirming GET', async () => {
 const fake = fakeEnvironment();
 const actor = createHandkey({ environment: fake.environment, persistence: savedPersistence() });
 fake.queue(json([wireRequest()]));
 await actor.refresh();
 const confirm = deferred<Response>();
 fake.queue(json({ status: 'processed' }), () => confirm.promise, json([]));
 const credential = sentinelKey();
 const assertZeroed = observeZeroing();
 const operation = actor.approve([request().id], credential);
 await flush();
 expect(fake.calls.map(call => `${call.method} ${new URL(call.url).pathname}`)).toEqual([
  'GET /v1/requests', 'POST /v1/requests/r1/approve', 'GET /v1/requests/r1',
 ]);
 try { assertZeroed(); }
 finally {
  confirm.resolve(json(wireRequest('r1', 'approved', 'ready')));
  expect(await operation).toEqual({ kind: 'finished', stopped: null, items: [{ id: 'r1', request: pendingRequest, outcome: { kind: 'executed', request: executedRequest } }] });
  await flush();
 }
 expect(fake.replies).toEqual([]);
 expect(fake.timers.size).toBe(0);
});

test('revokeSibling zeroes bytes before waiting for the view GET after a POST 401', async () => {
 const fake = fakeEnvironment();
 const actor = createHandkey({ environment: fake.environment, persistence: savedPersistence() });
 const view = deferred<Response>();
 fake.queue(json({}, 401), () => view.promise);
 const credential = sentinelKey();
 const assertZeroed = observeZeroing();
 const operation = actor.revokeSibling(sessionId(), credential);
 await flush();
 expect(fake.calls.map(call => `${call.method} ${new URL(call.url).pathname}`)).toEqual([
  'POST /v1/sessions/sibling/revoke', 'GET /v1/devices/device/sessions',
 ]);
 try { assertZeroed(); }
 finally {
  view.resolve(json(wireSessions()));
  expect(await operation).toEqual({ kind: 'key-rejected' });
 }
 expect(fake.timers.size).toBe(0);
});
