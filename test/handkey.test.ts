import { inspect as nodeInspect } from 'node:util';
import { describe, expect, it } from 'vitest';
import { createHandkey } from '../src/handkey.js';
import type { Handkey } from '../src/handkey.js';
import { memoryPersistence } from '../src/environment.js';
import { aborting, count, created, deferred, fakeEnvironment, flush, json, KEY, key, NOW, request, savedPersistence, sessionId, sse, TOKEN, URL_BASE, wireRequest, wireSessions } from './helpers.js';

function active(actor: Handkey) {
 const snapshot = actor.getSnapshot();
 if (snapshot.kind !== 'active') throw new Error('Expected active actor');
 return snapshot;
}
function setup() {
 const fake = fakeEnvironment();
 const persistence = savedPersistence();
 const actor = createHandkey({ environment: fake.environment, persistence });
 return { fake, persistence, actor };
}
const registration = () => ({ brokerUrl: URL_BASE, deviceId: 'device', name: 'Laptop', key: key() });

describe('approval broker status policy through the actor', () => {
 const rows = [
  { label: '200 ready', post: 200, get: 200, approval: 'approved', execution: 'ready', outcome: 'executed', stop: null },
  { label: '200 succeeded', post: 200, get: 200, approval: 'approved', execution: 'succeeded', outcome: 'executed', stop: null },
  { label: '200 consumed', post: 200, get: 200, approval: 'approved', execution: 'consumed', outcome: 'executed', stop: null },
  { label: '200 failed', post: 200, get: 200, approval: 'approved', execution: 'failed', outcome: 'execution-failed', stop: null },
  { label: '200 unknown', post: 200, get: 200, approval: 'approved', execution: 'unknown', outcome: 'outcome-unknown', stop: null },
  { label: '200 GET failure', post: 200, get: 500, approval: 'pending', execution: 'not_started', outcome: 'outcome-unknown', stop: null },
  { label: '409', post: 409, get: 200, approval: 'denied', execution: 'not_started', outcome: 'already-decided', stop: null },
  { label: '409 GET failure', post: 409, get: 500, approval: 'pending', execution: 'not_started', outcome: 'already-decided', stop: null },
  { label: '401 GET401', post: 401, get: 401, approval: 'pending', execution: 'not_started', outcome: 'session-ended', stop: 'session-ended' },
  { label: '401 GET200', post: 401, get: 200, approval: 'pending', execution: 'not_started', outcome: 'key-rejected', stop: 'key-rejected' },
  { label: '401 GET404', post: 401, get: 404, approval: 'pending', execution: 'not_started', outcome: 'key-rejected', stop: 'key-rejected' },
  { label: '401 GET500', post: 401, get: 500, approval: 'pending', execution: 'not_started', outcome: 'auth-undetermined', stop: 'auth-undetermined' },
  { label: '404', post: 404, get: 0, approval: 'pending', execution: 'not_started', outcome: 'not-found', stop: 'not-found' },
  { label: '503 approved', post: 503, get: 200, approval: 'approved', execution: 'ready', outcome: 'executed', stop: 'interrupted' },
  { label: '500 decided', post: 500, get: 200, approval: 'denied', execution: 'not_started', outcome: 'already-decided', stop: 'interrupted' },
  { label: '500 pending', post: 500, get: 200, approval: 'pending', execution: 'not_started', outcome: 'interrupted', stop: 'interrupted' },
  { label: 'network approved failed', post: -1, get: 200, approval: 'approved', execution: 'failed', outcome: 'execution-failed', stop: 'interrupted' },
  { label: 'network pending', post: -1, get: 200, approval: 'pending', execution: 'not_started', outcome: 'interrupted', stop: 'interrupted' },
  { label: 'timeout approved', post: -2, get: 200, approval: 'approved', execution: 'unknown', outcome: 'outcome-unknown', stop: 'interrupted' },
  { label: '400 pending', post: 400, get: 200, approval: 'pending', execution: 'not_started', outcome: 'interrupted', stop: 'interrupted' },
 ];
 it.each(rows)('$label confirms execution and applies the batch stop rule', async row => {
  const { actor, fake, persistence } = setup();
  const first = request('r1').id, second = request('r2').id;
  fake.queue(row.post === -1 ? new Error(`transport ${KEY} ${TOKEN}`) : row.post === -2 ? aborting : json({ status: 'processed' }, row.post));
  if (row.get !== 0) fake.queue(json(wireRequest('r1', row.approval, row.execution), row.get));
  if (row.stop === null) fake.queue(json({ status: 'processed' }), json(wireRequest('r2', 'approved', 'ready')));
  const credential = key();
  const pending = actor.approve([first, second], credential);
  expect(active(actor).approval?.items[0]?.step.kind).toBe('approving');
  if (row.post === -2) await fake.advance(150_000);
  const report = await pending;
  if (report.kind !== 'finished') throw new Error('Expected finished approval');
  expect(report.items.map(item => item.outcome.kind)).toEqual([row.outcome, row.stop === null ? 'executed' : 'not-sent']);
  expect(report.stopped).toBe(row.stop);
  expect(fake.calls.map(call => `${call.method} ${new URL(call.url).pathname}`)).toEqual([
   'POST /v1/requests/r1/approve', ...(row.get === 0 ? [] : ['GET /v1/requests/r1']),
   ...(row.stop === null ? ['POST /v1/requests/r2/approve', 'GET /v1/requests/r2'] : []),
  ]);
  expect(await actor.approve([second], credential)).toEqual({ kind: 'key-spent' });
  expect(JSON.stringify([report, actor.getSnapshot(), persistence.read()])).not.toContain(KEY);
  expect(JSON.stringify([report, actor.getSnapshot()])).not.toContain(TOKEN);
  if (row.stop === 'session-ended') {
   expect(actor.getSnapshot()).toEqual({ kind: 'register', reason: 'rejected', remembered: { brokerUrl: URL_BASE, deviceId: 'device' } });
   expect(persistence.read()).toBeNull();
  }
 });
 it('publishes sequential progress, refuses busy keys, deduplicates, and dismisses only finished progress', async () => {
  const { actor, fake } = setup();
  const post = deferred<Response>(), get = deferred<Response>();
  fake.queue(() => post.promise, () => get.promise, json({ status: 'processed' }), json(wireRequest('r2', 'approved', 'ready')));
  const one = request().id, two = request('r2').id;
  const run = actor.approve([one, one, two], key());
  const busyKey = key();
  expect(await actor.approve([two], busyKey)).toEqual({ kind: 'busy' });
  expect(await actor.approve([two], busyKey)).toEqual({ kind: 'key-spent' });
  expect(await actor.approve([two], key())).toEqual({ kind: 'busy' });
  expect(await actor.register(registration())).toEqual({ kind: 'busy' });
  actor.dismissApproval();
  expect(active(actor).approval?.items.map(item => item.step.kind)).toEqual(['approving', 'queued']);
  post.resolve(json({ status: 'processed' })); await flush();
  expect(active(actor).approval?.items.map(item => item.step.kind)).toEqual(['confirming', 'queued']);
  get.resolve(json(wireRequest('r1', 'approved', 'ready')));
  expect((await run).kind).toBe('finished');
  expect(active(actor).approval?.items.map(item => item.step.kind)).toEqual(['done', 'done']);
  actor.dismissApproval(); expect(active(actor).approval).toBeNull();
 });
 it('refuses unrecognized methods before POST but continues reviewable selections', async () => {
  const { actor, fake } = setup();
  fake.queue(json([wireRequest('future', 'pending', 'not_started', NOW + 300_000, 'new-method'), wireRequest('r1')]));
  await actor.refresh();
  fake.queue(json({ status: 'processed' }), json(wireRequest('r1', 'approved', 'ready')));
  const report = await actor.approve([request('future').id, request().id], key());
  if (report.kind !== 'finished') throw new Error('Expected report');
  expect(report.items.map(item => item.outcome.kind)).toEqual(['not-sent', 'executed']);
  expect(report.items[0]?.outcome).toEqual({ kind: 'not-sent', because: 'not-reviewable' });
  expect(count(fake.calls, '/future/approve')).toBe(0);
 });
});

describe('credential ownership and registration', () => {
 it('has stable credential-free initial snapshots and no eager effects', () => {
  const fake = fakeEnvironment(), actor = createHandkey({ environment: fake.environment });
  expect(actor.getSnapshot()).toEqual({ kind: 'register', reason: 'never-registered', remembered: null });
  expect(actor.getSnapshot()).toBe(actor.getSnapshot());
  expect(fake.calls).toEqual([]);
  expect(fake.timers.size).toBe(0);
  const credential = key();
  expect([String(credential), JSON.stringify(credential), nodeInspect(credential)]).toEqual(['[DeviceKey]', '"[DeviceKey]"', '[DeviceKey]']);
 });
 it.each([
  { brokerUrl: 'https://broker.example/path', deviceId: 'device', name: '', kind: 'invalid-broker-url' },
  { brokerUrl: URL_BASE, deviceId: '', name: '', kind: 'invalid-device-id' },
  { brokerUrl: URL_BASE, deviceId: 'device', name: 'x'.repeat(129), kind: 'invalid-name' },
  { brokerUrl: URL_BASE, deviceId: 'device', name: '\ud800', kind: 'invalid-name' },
 ])('register guard $kind spends its key without network', async row => {
  const fake = fakeEnvironment(), actor = createHandkey({ environment: fake.environment });
  const credential = key();
  expect(await actor.register({ ...row, key: credential })).toEqual({ kind: row.kind });
  expect(await actor.register({ ...registration(), key: credential })).toEqual({ kind: 'key-spent' });
  expect(fake.calls).toEqual([]);
  expect(actor.getSnapshot().kind).toBe('register');
 });
 it('every preflight guard claims once including missing session and empty batch', async () => {
  const fake = fakeEnvironment(), actor = createHandkey({ environment: fake.environment });
  const approvalKey = key(), revokeKey = key(), listKey = key(), keyRevoke = key();
  expect(await actor.approve([request().id], approvalKey)).toEqual({ kind: 'not-registered' });
  expect(await actor.approve([request().id], approvalKey)).toEqual({ kind: 'key-spent' });
  expect(await actor.revokeSibling(sessionId(), revokeKey)).toEqual({ kind: 'not-registered' });
  expect(await actor.revokeSibling(sessionId(), revokeKey)).toEqual({ kind: 'key-spent' });
  expect(await actor.listSessionsWithKey({ brokerUrl: 'invalid', deviceId: 'device', key: listKey })).toEqual({ kind: 'invalid-broker-url' });
  expect(await actor.listSessionsWithKey({ brokerUrl: URL_BASE, deviceId: 'device', key: listKey })).toEqual({ kind: 'key-spent' });
  expect(await actor.revokeSessionWithKey({ brokerUrl: URL_BASE, deviceId: '', sessionId: sessionId(), key: keyRevoke })).toEqual({ kind: 'invalid-device-id' });
  expect(await actor.revokeSessionWithKey({ brokerUrl: URL_BASE, deviceId: 'device', sessionId: sessionId(), key: keyRevoke })).toEqual({ kind: 'key-spent' });
  const registered = createHandkey({ environment: fake.environment, persistence: savedPersistence() }), emptyKey = key();
  expect(await registered.approve([], emptyKey)).toEqual({ kind: 'empty' });
  expect(await registered.approve([], emptyKey)).toEqual({ kind: 'key-spent' });
  expect(fake.calls).toEqual([]);
 });
 it.each([{ status: 401, kind: 'rejected' }, { status: 409, kind: 'session-limit' }, { status: 500, kind: 'failed' }, { status: -1, kind: 'failed' }])('registration $status does not create a session', async row => {
  const fake = fakeEnvironment(), persistence = memoryPersistence(), actor = createHandkey({ environment: fake.environment, persistence });
  fake.queue(row.status === -1 ? new Error(KEY + TOKEN) : json({ error: KEY + TOKEN }, row.status));
  const credential = key();
  const result = await actor.register({ ...registration(), key: credential });
  expect(result).toEqual(row.kind === 'failed' ? { kind: 'failed', fault: { kind: row.status === -1 ? 'network' : 'unavailable' } } : { kind: row.kind });
  expect(await actor.register({ ...registration(), key: credential })).toEqual({ kind: 'key-spent' });
  expect(persistence.read()).toBeNull();
  expect(actor.getSnapshot().kind).toBe('register');
  expect(JSON.stringify([result, actor.getSnapshot()])).not.toContain(KEY);
 });
 it('registers, persists only the view capability, and self-revokes the previous session', async () => {
  const { actor, fake, persistence } = setup();
  fake.queue(json(created('replacement', 'new-view-token'), 201), json({ status: 'revoked' }));
  expect(await actor.register(registration())).toEqual({ kind: 'registered', persistence: 'saved' });
  expect(active(actor).session.sessionId).toBe('replacement');
  expect(fake.calls.map(call => [new URL(call.url).pathname, call.headers.get('Authorization'), call.body])).toEqual([
   ['/v1/devices/device/sessions', null, JSON.stringify({ key: KEY, name: 'Laptop' })],
   ['/v1/sessions/session/revoke', `Bearer ${TOKEN}`, undefined],
  ]);
  expect(persistence.read()).toContain('new-view-token');
  expect(JSON.stringify(actor.getSnapshot())).not.toContain('new-view-token');
  expect(persistence.read()).not.toContain(KEY);
 });
});

describe('view and key-only routes', () => {
 it('reads sessions and requests, denies without body, revokes siblings with a key, and signs out without one', async () => {
  const { actor, fake, persistence } = setup();
  fake.queue(json(wireSessions()), json(wireRequest()), json({ status: 'denied' }), json({ status: 'revoked' }), new Error('offline'));
  const sessions = await actor.sessions();
  expect(sessions.kind).toBe('ok');
  if (sessions.kind !== 'ok') throw new Error('Expected sessions');
  expect(sessions.value.map(value => [value.sessionId, value.name])).toEqual([['sibling', 'Phone <script>']]);
  const inspected = await actor.inspect(request().id);
  if (inspected.kind !== 'ok') throw new Error('Expected request');
  expect(inspected.value.agent).toBe('agent <script>');
  expect(await actor.deny([request().id])).toEqual({ kind: 'finished', items: [{ id: 'r1', outcome: { kind: 'denied' } }], stopped: null });
  expect(await actor.revokeSibling(sessionId(), key())).toEqual({ kind: 'ok' });
  await actor.signOut();
  expect(actor.getSnapshot()).toEqual({ kind: 'register', reason: 'signed-out', remembered: { brokerUrl: URL_BASE, deviceId: 'device' } });
  expect(persistence.read()).toBeNull();
  expect(fake.calls.map(call => [call.method, new URL(call.url).pathname, call.body, call.headers.get('Content-Type')])).toEqual([
   ['GET', '/v1/devices/device/sessions', undefined, null], ['GET', '/v1/requests/r1', undefined, null],
   ['POST', '/v1/requests/r1/deny', undefined, null], ['POST', '/v1/sessions/sibling/revoke', JSON.stringify({ key: KEY }), 'application/json'],
   ['POST', '/v1/sessions/session/revoke', undefined, null],
  ]);
  for (const call of fake.calls) {
   expect(call.headers.get('Authorization')).toBe(`Bearer ${TOKEN}`);
   expect([call.init?.cache, call.init?.credentials, call.init?.redirect]).toEqual(['no-store', 'omit', 'error']);
   expect(call.url).not.toContain(TOKEN);
  }
 });
 it('key administration needs no registration or Authorization and encodes path identifiers', async () => {
  const fake = fakeEnvironment(), actor = createHandkey({ environment: fake.environment });
  fake.queue(json(wireSessions('other/phone')), json({ status: 'revoked' }));
  const result = await actor.listSessionsWithKey({ brokerUrl: URL_BASE + '/', deviceId: 'device/one', key: key() });
  if (result.kind !== 'ok') throw new Error('Expected key sessions');
  expect(result.value[0]?.sessionId).toBe('other/phone');
  expect(await actor.revokeSessionWithKey({ brokerUrl: URL_BASE, deviceId: 'device/one', sessionId: sessionId('other/phone'), key: key() })).toEqual({ kind: 'ok' });
  expect(fake.calls.map(call => [call.method, new URL(call.url).pathname, call.headers.get('Authorization'), call.headers.get('Content-Type'), call.body])).toEqual([
   ['POST', '/v1/devices/device%2Fone/sessions/list', null, 'application/json', JSON.stringify({ key: KEY })],
   ['POST', '/v1/devices/device%2Fone/sessions/other%2Fphone/revoke', null, 'application/json', JSON.stringify({ key: KEY })],
  ]);
  expect(actor.getSnapshot().kind).toBe('register');
 });
 it.each([{ status: 401, fault: null }, { status: 409, fault: 'protocol' }, { status: -1, fault: 'network' }])('key session listing $status never logs out the view session', async row => {
  const { actor, fake } = setup();
  fake.queue(row.status === -1 ? new Error(KEY + TOKEN) : json({ error: KEY + TOKEN }, row.status));
  const credential = key();
  const result = await actor.listSessionsWithKey({ brokerUrl: URL_BASE, deviceId: 'device', key: credential });
  expect(result).toEqual(row.fault === null ? { kind: 'rejected' } : { kind: 'failed', fault: { kind: row.fault } });
  expect(await actor.listSessionsWithKey({ brokerUrl: URL_BASE, deviceId: 'device', key: credential })).toEqual({ kind: 'key-spent' });
  expect(active(actor).session.sessionId).toBe('session');
  expect(JSON.stringify(result)).not.toContain(KEY);
  expect(JSON.stringify(result)).not.toContain(TOKEN);
 });
 it.each([{ status: 401, result: 'rejected' }, { status: 404, result: 'not-found' }, { status: 503, result: 'failed' }])('key revocation $status stays independent of the view session', async row => {
  const { actor, fake } = setup(); fake.queue(json({ error: TOKEN + KEY }, row.status));
  const result = await actor.revokeSessionWithKey({ brokerUrl: URL_BASE, deviceId: 'device', sessionId: sessionId(), key: key() });
  expect(result).toEqual(row.result === 'failed' ? { kind: 'failed', fault: { kind: 'unavailable' } } : { kind: row.result });
  expect(active(actor).session.sessionId).toBe('session');
 });
 it.each([200, 401, 404, 500])('disambiguates sibling POST401 using GET$status', async status => {
  const { actor, fake } = setup(); fake.queue(json({}, 401), json(wireSessions(), status));
  expect(await actor.revokeSibling(sessionId(), key())).toEqual({ kind: status === 401 ? 'session-ended' : status === 500 ? 'auth-undetermined' : 'key-rejected' });
  expect(actor.getSnapshot().kind).toBe(status === 401 ? 'register' : 'active');
 });
 it.each(['inspect', 'sessions', 'refresh'])('view 401 in $0 forgets credentials', async method => {
  const { actor, fake, persistence } = setup(); fake.queue(json({ error: TOKEN }, 401));
  if (method === 'inspect') expect(await actor.inspect(request().id)).toEqual({ kind: 'session-ended' });
  else if (method === 'sessions') expect(await actor.sessions()).toEqual({ kind: 'session-ended' });
  else await actor.refresh();
  expect(actor.getSnapshot()).toEqual({ kind: 'register', reason: 'rejected', remembered: { brokerUrl: URL_BASE, deviceId: 'device' } });
  expect(persistence.read()).toBeNull();
 });
 it.each([{ status: 200, outcome: 'denied', stop: null }, { status: 409, outcome: 'already-decided', stop: null }, { status: 401, outcome: 'session-ended', stop: 'session-ended' }, { status: 404, outcome: 'not-found', stop: 'not-found' }, { status: 503, outcome: 'interrupted', stop: 'interrupted' }])('deny $status is sequential and applies stop semantics', async row => {
  const { actor, fake } = setup(); fake.queue(json({ status: 'denied' }, row.status));
  if (row.stop === null) fake.queue(json({ status: 'denied' }));
  const report = await actor.deny([request().id, request().id, request('r2').id]);
  expect(report).toEqual({ kind: 'finished', items: [{ id: 'r1', outcome: { kind: row.outcome } }, { id: 'r2', outcome: { kind: row.stop === null ? 'denied' : 'not-sent' } }], stopped: row.stop });
  expect(fake.calls.map(call => call.body)).toEqual(row.stop === null ? [undefined, undefined] : [undefined]);
 });
});

describe('actor epochs, persistence and deadlines', () => {
 it('adopts the newer stored session when registration loses its compare-and-swap race', async () => {
  const fake = fakeEnvironment();
  const newer = JSON.stringify({ version: 1, brokerUrl: URL_BASE, deviceId: 'device', sessionId: 'newer', viewToken: 'newer-view-token', viewUntil: NOW + 86_400_000 });
  let stored = savedPersistence().read();
  const actor = createHandkey({ environment: fake.environment, persistence: {
   read: () => stored,
   compareAndSwap() { stored = newer; return false; },
  } });
  fake.queue(json(created('losing-registration', 'losing-view-token'), 201), json({ status: 'revoked' }));
  expect(await actor.register(registration())).toEqual({ kind: 'registered', persistence: 'superseded' });
  expect(active(actor).session.sessionId).toBe('newer');
  expect(stored).toBe(newer);
  expect(JSON.stringify(actor.getSnapshot())).not.toContain('newer-view-token');
  expect(JSON.stringify(actor.getSnapshot())).not.toContain('losing-view-token');
  expect(fake.calls.map(call => new URL(call.url).pathname)).toEqual(['/v1/devices/device/sessions', '/v1/sessions/session/revoke']);
 });
 it('reports failed persistence without leaking the credential or throwing storage diagnostics', async () => {
  const fake = fakeEnvironment();
  const actor = createHandkey({ environment: fake.environment, persistence: {
   read: () => null,
   compareAndSwap() { throw new Error(KEY + TOKEN); },
  } });
  fake.queue(json(created(), 201));
  const result = await actor.register(registration());
  expect(result).toEqual({ kind: 'registered', persistence: 'failed' });
  expect(active(actor).session.sessionId).toBe('session');
  expect(JSON.stringify([result, actor.getSnapshot()])).not.toContain(KEY);
  expect(JSON.stringify([result, actor.getSnapshot()])).not.toContain(TOKEN);
 });
 it('keeps registration busy until its owner finishes and spends rejected concurrent keys', async () => {
  const fake = fakeEnvironment(), actor = createHandkey({ environment: fake.environment });
  const held = deferred<Response>(); fake.queue(() => held.promise);
  const pending = actor.register(registration());
  const refused = key();
  expect(await actor.register({ ...registration(), key: refused })).toEqual({ kind: 'busy' });
  expect(await actor.register({ ...registration(), key: refused })).toEqual({ kind: 'key-spent' });
  expect(await actor.register(registration())).toEqual({ kind: 'busy' });
  held.resolve(json(created(), 201));
  expect(await pending).toEqual({ kind: 'registered', persistence: 'saved' });
  expect(fake.calls.length).toBe(1);
  expect(active(actor).session.sessionId).toBe('session');
 });
 it('fences stale reads after signout and never erases a newer CAS registration', async () => {
  const { actor, fake, persistence } = setup();
  const stale = deferred<Response>(); fake.queue(() => stale.promise, json({ status: 'revoked' }));
  const read = actor.inspect(request().id);
  const newer = JSON.stringify({ version: 1, brokerUrl: URL_BASE, deviceId: 'device', sessionId: 'newer', viewToken: 'newer-token', viewUntil: NOW + 86_400_000 });
  expect(persistence.compareAndSwap(persistence.read(), newer)).toBe(true);
  await actor.signOut();
  expect(active(actor).session.sessionId).toBe('newer');
  stale.resolve(json(wireRequest()));
  expect(await read).toEqual({ kind: 'session-ended' });
  expect(persistence.read()).toBe(newer);
  expect(active(actor).pending).toEqual([]);
 });
 it('subscribed actors adopt each other and stale network completions cannot poison the replacement', async () => {
  const persistence = savedPersistence();
  const firstFake = fakeEnvironment(), secondFake = fakeEnvironment();
  const first = createHandkey({ persistence, environment: firstFake.environment }), second = createHandkey({ persistence, environment: secondFake.environment });
  const firstStream = sse(), secondStream = sse(), replacementOne = sse(), replacementTwo = sse();
  const stale = deferred<Response>();
  firstFake.queue(firstStream.response, () => stale.promise);
  secondFake.queue(secondStream.response, json(created('replacement', 'replacement-token'), 201), json({ status: 'revoked' }), replacementTwo.response);
  const offOne = first.subscribe(() => {}), offTwo = second.subscribe(() => {}); await flush();
  const staleRefresh = first.refresh();
  firstFake.queue(replacementOne.response);
  expect(await second.register(registration())).toEqual({ kind: 'registered', persistence: 'saved' });
  stale.resolve(json({}, 401)); await staleRefresh; await flush();
  expect([active(first).session.sessionId, active(second).session.sessionId]).toEqual(['replacement', 'replacement']);
  expect(persistence.read()).toContain('replacement-token');
  expect(firstStream.cancelled).toBe(true);
  offOne(); offTwo(); await flush();
  expect([firstFake.timers.size, secondFake.timers.size]).toEqual([0, 0]);
 });
 it('locally prunes nearest deadlines with an id tie break and counts unreadable entries', async () => {
  const { actor, fake } = setup(); const stream = sse();
  fake.queue(stream.response, json([wireRequest('z', 'pending', 'not_started', NOW + 2000), wireRequest('b', 'pending', 'not_started', NOW + 1000), {}, wireRequest('a', 'pending', 'not_started', NOW + 1000), wireRequest('old', 'pending', 'not_started', NOW)]));
  const off = actor.subscribe(() => {}); await flush(); stream.push('event: sync\ndata: {}\n\n'); await flush();
  expect(active(actor).pending.map(value => value.id)).toEqual(['a', 'b', 'z']);
  expect(active(actor).unreadable).toBe(1);
  await fake.advance(1000); expect(active(actor).pending.map(value => value.id)).toEqual(['z']);
  await fake.advance(1000); expect(active(actor).pending).toEqual([]);
  expect(count(fake.calls, '/v1/requests')).toBe(1);
  off(); await flush(); expect(fake.timers.size).toBe(0);
 });
 it('expires a persisted session locally and rejects malformed persistence', async () => {
  const fake = fakeEnvironment(), persistence = savedPersistence();
  const actor = createHandkey({ environment: fake.environment, persistence }); const stream = sse();
  fake.queue(stream.response); const off = actor.subscribe(() => {}); await flush();
  const saved = persistence.read();
  expect(saved).toContain(TOKEN);
  const next = JSON.stringify({ version: 1, brokerUrl: URL_BASE, deviceId: 'device', sessionId: 'short', viewToken: TOKEN, viewUntil: NOW + 1000 });
  fake.queue(sse().response); persistence.compareAndSwap(saved, next); await flush(); await fake.advance(1000);
  expect(actor.getSnapshot()).toEqual({ kind: 'register', reason: 'expired', remembered: { brokerUrl: URL_BASE, deviceId: 'device' } });
  off();
  persistence.compareAndSwap(null, '{invalid');
  expect(createHandkey({ environment: fake.environment, persistence }).getSnapshot()).toEqual({ kind: 'register', reason: 'invalid-saved-session', remembered: null });
  expect(persistence.read()).toBeNull();
 });
});

describe('controlled SSE and feed lifecycle', () => {
 it('aborts a pending list and pending events fetch when the final subscriber leaves', async () => {
  const { actor, fake } = setup();
  fake.queue(aborting, aborting);
  const off = actor.subscribe(() => {}); await flush();
  const refresh = actor.refresh(); await flush();
  expect(active(actor).list.kind).toBe('loading');
  off(); await refresh; await flush();
  expect(fake.calls.map(call => call.signal?.aborted)).toEqual([true, true]);
  expect(fake.timers.size).toBe(0);
  expect(active(actor).session.sessionId).toBe('session');
 });
 it('watchdog also bounds a stalled initial events fetch', async () => {
  const { actor, fake } = setup(); fake.queue(aborting);
  const off = actor.subscribe(() => {}); await flush();
  await fake.advance(25_000);
  expect(active(actor).connection).toBe('retrying');
  expect(fake.calls[0]?.signal?.aborted).toBe(true);
  off(); expect(fake.timers.size).toBe(0);
 });
 it('handles split CRLF sync, every hint, five-hint bursts, single-flight refresh and visibility', async () => {
  const { actor, fake } = setup(); const stream = sse();
  fake.queue(stream.response, json([wireRequest()])); const off = actor.subscribe(() => {}); await flush();
  stream.push('event: sy'); stream.push('nc\r'); stream.push('\ndata: {}\r\n\r'); stream.push('\n'); await flush();
  expect(active(actor).connection).toBe('live'); expect(active(actor).pending.map(value => value.id)).toEqual(['r1']);
  const list = deferred<Response>(); fake.queue(() => list.promise, json([wireRequest('r2')]));
  stream.push('event: change\ndata: {}\n\n'.repeat(5)); await flush();
  expect(count(fake.calls, '/v1/requests')).toBe(2);
  list.resolve(json([wireRequest('r1')])); await flush();
  expect(count(fake.calls, '/v1/requests')).toBe(3);
  expect(active(actor).pending.map(value => value.id)).toEqual(['r2']);
  fake.queue(json([wireRequest('r3')])); fake.visibility(false); await flush();
  expect(count(fake.calls, '/v1/requests')).toBe(3);
  fake.visibility(true); await flush();
  expect(active(actor).pending.map(value => value.id)).toEqual(['r3']);
  const held = deferred<Response>(); fake.queue(() => held.promise, json([wireRequest('r4')]));
  const one = actor.refresh(), two = actor.refresh(); held.resolve(json([])); await Promise.all([one, two]);
  expect(active(actor).pending.map(value => value.id)).toEqual(['r4']);
  off(); await flush(); expect(stream.cancelled).toBe(true); expect(fake.timers.size).toBe(0);
 });
 it('watchdog aborts after silence, reconnect relists, heartbeat extends watchdog, and unsubscribe clears everything', async () => {
  const { actor, fake } = setup(); const first = sse(), second = sse();
  fake.queue(first.response, json([wireRequest('reconnected')]), second.response, json([wireRequest('after-sync')]));
  const off = actor.subscribe(() => {}); await flush();
  await fake.advance(24_000); first.push(': heartbeat\r\n\r\n'); await flush();
  await fake.advance(24_999); expect(active(actor).connection).toBe('connecting');
  await fake.advance(1); expect(active(actor).connection).toBe('retrying'); expect(first.cancelled).toBe(true);
  await fake.advance(999); expect(count(fake.calls, '/v1/events')).toBe(1);
  await fake.advance(1); expect(count(fake.calls, '/v1/events')).toBe(2);
  expect(active(actor).pending.map(value => value.id)).toEqual(['reconnected']);
  second.push('event: sync\ndata: {}\n\n'); await flush(); expect(active(actor).connection).toBe('live');
  off(); off(); await flush(); expect(second.cancelled).toBe(true); expect(fake.timers.size).toBe(0);
  await fake.advance(120_000); expect(count(fake.calls, '/v1/events')).toBe(2);
 });
 it('uses capped exponential backoff and polls at 60 seconds while down', async () => {
  const { actor, fake } = setup();
  fake.queue(json({}, 503)); const off = actor.subscribe(() => {}); await flush();
  expect(active(actor).connection).toBe('retrying');
  for (const delay of [1000, 2000, 4000, 8000, 16000]) {
   fake.queue(json([]), json({}, 503)); await fake.advance(delay);
  }
  expect(count(fake.calls, '/v1/events')).toBe(6);
  fake.queue(json([wireRequest('poll')])); await fake.advance(29_000);
  expect(active(actor).pending.map(value => value.id)).toEqual(['poll']);
  expect(count(fake.calls, '/v1/requests')).toBe(6);
  fake.queue(json([]), json({}, 401)); await fake.advance(1000);
  expect(actor.getSnapshot().kind).toBe('register');
  expect(actor.getSnapshot()).toMatchObject({ reason: 'rejected' });
  off(); expect(fake.timers.size).toBe(0);
 });
});
