import { describe, expect, it } from 'vitest';
import { createBroker, readEvents } from '../src/broker.js';
import type { Environment } from '../src/environment.js';
import { parseRequest, parseSessionCreated } from '../src/parse.js';

const wireRequest = { id: 'request /?', spec: { method: 'otp', reason: '' }, approval: 'pending', execution: 'not_started', created_at: '2026-10-06T00:00:00Z', deadline: '2026-10-06T00:15:00Z', used: 0 };
function fixture() {
  const session = parseSessionCreated({ value: { id: 'device /?', session_id: 'session /?', view_token: 'view-only', view_until: '2027-01-01T00:00:00Z' }, brokerUrl: 'https://broker.test', deviceId: 'device /?' });
  const request = parseRequest(wireRequest);
  if (session.kind !== 'ok' || request.kind !== 'ok') throw new Error('Invalid fixture');
  return { session: session.value, id: request.value.id };
}
function scripted(responses: Array<Response | (() => Promise<Response>)>) {
  const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
  const timers = new Map<object, { callback: () => void; ms: number }>();
  const environment: Environment = {
    fetch: async (url, init) => {
      calls.push({ url: String(url), init });
      const response = responses.shift();
      if (!response) throw new Error('Script exhausted');
      return typeof response === 'function' ? response() : response;
    },
    now: () => 0, random: () => 0.5,
    setTimeout(callback, ms) { const handle = {}; timers.set(handle, { callback, ms }); return handle; },
    clearTimeout(handle) { if (typeof handle === 'object' && handle !== null) timers.delete(handle); },
  };
  return { broker: createBroker(environment), calls, timers };
}
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });
function chunks(parts: string[]): ReadableStream<Uint8Array> {
  return new ReadableStream({ start(controller) { for (const part of parts) controller.enqueue(new TextEncoder().encode(part)); controller.close(); } });
}

describe('Broker', () => {
  it('creates a parsed session and posts key-only administration without bearer credentials', async () => {
    const { session } = fixture();
    const { broker, calls } = scripted([json({ id: session.deviceId, session_id: session.sessionId, view_token: session.viewToken, view_until: '2027-01-01T00:00:00Z' }, 201), json([]), json({ status: 'revoked' })]);
    const bytes = new Uint8Array(32);
    expect(await broker.createSession({ brokerUrl: session.brokerUrl, deviceId: session.deviceId, name: 'Phone', bytes })).toEqual({ kind: 'ok', value: session });
    expect(await broker.keySessions({ brokerUrl: session.brokerUrl, deviceId: session.deviceId, bytes })).toEqual({ kind: 'ok', value: [] });
    expect(await broker.keyRevoke({ brokerUrl: session.brokerUrl, deviceId: session.deviceId, sessionId: session.sessionId, bytes })).toEqual({ kind: 'ok', value: undefined });
    expect(calls.map(call => call.url)).toEqual(['https://broker.test/v1/devices/device%20%2F%3F/sessions', 'https://broker.test/v1/devices/device%20%2F%3F/sessions/list', 'https://broker.test/v1/devices/device%20%2F%3F/sessions/session%20%2F%3F/revoke']);
    for (const call of calls) {
      expect(call.init?.method).toBe('POST');
      const headers = new Headers(call.init?.headers);
      expect(headers.get('Authorization')).toBe(null);
      expect(headers.get('Content-Type')).toBe('application/json');
      expect(call.init?.cache).toBe('no-store');
      expect(call.init?.credentials).toBe('omit');
      expect(call.init?.redirect).toBe('error');
    }
    expect(calls[0]?.init?.body).toBe('{"key":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA","name":"Phone"}');
    expect(calls[1]?.init?.body).toBe('{"key":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"}');
  });
  it('parses lists and detail through real view routes and tolerates unreadable list entries', async () => {
    const { session, id } = fixture();
    const { broker, calls } = scripted([json([]), json([wireRequest, null]), json(wireRequest)]);
    expect(await broker.sessions(session)).toEqual({ kind: 'ok', value: [] });
    const parsed = parseRequest(wireRequest);
    if (parsed.kind !== 'ok') throw new Error('Invalid fixture');
    expect(await broker.pending(session)).toEqual({ kind: 'ok', value: { requests: [parsed.value], unreadable: 1 } });
    expect(await broker.request({ session, id })).toEqual({ kind: 'ok', value: parsed.value });
    expect(calls[2]?.url).toBe('https://broker.test/v1/requests/request%20%2F%3F');
    expect(calls.map(call => new Headers(call.init?.headers).get('Authorization'))).toEqual(['Bearer view-only', 'Bearer view-only', 'Bearer view-only']);
  });
  it('checks mutation status and omits both body and content type for deny and self revoke', async () => {
    const { session, id } = fixture();
    const { broker, calls } = scripted([json({ status: 'processed' }), json({ status: 'denied' }), json({ status: 'revoked' }), json({ status: 'processed' })]);
    expect(await broker.approve({ session, id, bytes: new Uint8Array(32) })).toEqual({ kind: 'ok', value: undefined });
    expect(await broker.deny({ session, id })).toEqual({ kind: 'ok', value: undefined });
    expect(await broker.revoke({ session, id: session.sessionId })).toEqual({ kind: 'ok', value: undefined });
    expect(await broker.deny({ session, id })).toEqual({ kind: 'failed', fault: { kind: 'protocol' } });
    for (const call of calls.slice(1)) {
      expect(call.init?.method).toBe('POST');
      expect(call.init?.body).toBe(undefined);
      expect(new Headers(call.init?.headers).get('Content-Type')).toBe(null);
    }
    expect(calls[0]?.init?.body).toBe('{"key":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"}');
  });
  it.each([[401, { kind: 'unauthorized' }], [409, { kind: 'conflict' }], [404, { kind: 'not-found' }], [503, { kind: 'failed', fault: { kind: 'unavailable' } }], [500, { kind: 'failed', fault: { kind: 'unavailable' } }], [400, { kind: 'failed', fault: { kind: 'protocol' } }], [415, { kind: 'failed', fault: { kind: 'protocol' } }]])('maps HTTP %s without reading its body', async (status, result) => {
    let reads = 0;
    const response = new Response('secret diagnostic', { status });
    response.json = async () => { reads++; throw new Error('Body must not be read'); };
    const { broker } = scripted([response]);
    expect(await broker.pending(fixture().session)).toEqual(result);
    expect(reads).toBe(0);
  });
  it('maps fetch rejection and invalid success JSON to closed faults', async () => {
    const { broker } = scripted([() => Promise.reject(new Error('secret')), new Response('not json')]);
    expect(await broker.pending(fixture().session)).toEqual({ kind: 'failed', fault: { kind: 'network' } });
    expect(await broker.pending(fixture().session)).toEqual({ kind: 'failed', fault: { kind: 'protocol' } });
  });
  it('times out a stalled fetch after 30 seconds and approval after 150 seconds', async () => {
    const { session, id } = fixture();
    const { broker, timers, calls } = scripted([() => new Promise(() => {}), () => new Promise(() => {})]);
    const pending = broker.pending(session);
    expect([...timers.values()].map(timer => timer.ms)).toEqual([30_000]);
    for (const timer of timers.values()) timer.callback();
    expect(await pending).toEqual({ kind: 'failed', fault: { kind: 'timeout' } });
    expect(calls[0]?.init?.signal?.aborted).toBe(true);
    const approval = broker.approve({ session, id, bytes: new Uint8Array(32) });
    expect([...timers.values()].map(timer => timer.ms)).toEqual([150_000]);
    for (const timer of timers.values()) timer.callback();
    expect(await approval).toEqual({ kind: 'failed', fault: { kind: 'timeout' } });
    expect(timers.size).toBe(0);
  });
  it('cancels the list and clears its timer even when fetch ignores abort', async () => {
    const { broker, timers, calls } = scripted([() => new Promise(() => {})]);
    const controller = new AbortController();
    const result = broker.pending(fixture().session, controller.signal);
    controller.abort();
    expect(await result).toEqual({ kind: 'failed', fault: { kind: 'network' } });
    expect(timers.size).toBe(0);
    expect(calls[0]?.init?.signal?.aborted).toBe(true);
  });
  it('opens SSE without a timer and validates MIME before exposing the stream', async () => {
    const { session } = fixture();
    const { broker, calls, timers } = scripted([new Response(chunks(['event: sync\ndata: {}\n\n']), { headers: { 'Content-Type': 'text/event-stream; charset=utf-8' } }), new Response('x', { headers: { 'Content-Type': 'application/json' } })]);
    const signal = new AbortController().signal;
    const opened = await broker.events({ session, signal });
    if (opened.kind !== 'ok') throw new Error('Stream failed');
    const frames: string[] = [];
    expect(await readEvents({ stream: opened.value, signal, onFrame: kind => frames.push(kind) })).toBe(null);
    expect(frames).toEqual(['sync']);
    expect(await broker.events({ session, signal })).toEqual({ kind: 'failed', fault: { kind: 'protocol' } });
    expect(timers.size).toBe(0);
    expect(calls[0]?.init?.signal).toBe(signal);
    expect(new Headers(calls[0]?.init?.headers).get('Accept')).toBe('text/event-stream');
  });
});

describe('readEvents', () => {
  it('decodes split LF and CRLF frames, comments, ignored fields, and discarded partial EOF', async () => {
    const frames: string[] = [];
    const stream = chunks(['event: sy', 'nc\r', '\ndata: {}\r\n\r', '\n: heartbeat\n\nevent: change\ndata: first\ndata: second\n\nevent: other\ndata: {}\n\nevent: change\ndata: unfinished']);
    expect(await readEvents({ stream, signal: new AbortController().signal, onFrame: kind => frames.push(kind) })).toBe(null);
    expect(frames).toEqual(['sync', 'heartbeat', 'change']);
    expect(stream.locked).toBe(false);
  });
  it('bounds the whole frame even when each line is small', async () => {
    const frames: string[] = [];
    const stream = chunks(['event: sync\ndata: {}\n\n', 'data: x\n'.repeat(10_000)]);
    expect(await readEvents({ stream, signal: new AbortController().signal, onFrame: kind => frames.push(kind) })).toEqual({ kind: 'protocol' });
    expect(frames).toEqual(['sync']);
    expect(stream.locked).toBe(false);
  });
  it('cancels an idle read when aborted and returns no fault', async () => {
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({ cancel() { cancelled = true; } });
    const controller = new AbortController();
    const result = readEvents({ stream, signal: controller.signal, onFrame() {} });
    controller.abort();
    expect(await result).toBe(null);
    expect(cancelled).toBe(true);
    expect(stream.locked).toBe(false);
  });
  it('rejects malformed UTF-8 and reports stream read errors without error details', async () => {
    const signal = new AbortController().signal;
    const malformed = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new Uint8Array([255])); controller.close(); } });
    expect(await readEvents({ stream: malformed, signal, onFrame() {} })).toEqual({ kind: 'protocol' });
    const broken = new ReadableStream<Uint8Array>({ start(controller) { controller.error(new Error('secret')); } });
    expect(await readEvents({ stream: broken, signal, onFrame() {} })).toEqual({ kind: 'network' });
  });
});
