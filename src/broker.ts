import type { Environment } from './environment.js';
import { keyBody } from './key.js';
import { parsePendingList, parseRequest, parseSessionCreated, parseSessionList } from './parse.js';
import type { Parsed, SessionRecord } from './parse.js';
import type { Request, RequestId, SessionId, SessionSummary } from './request.js';

export type Fault = { readonly kind: 'network' | 'timeout' | 'unavailable' | 'protocol' | 'storage' };
export type Reply<T> =
  | { readonly kind: 'ok'; readonly value: T }
  | { readonly kind: 'unauthorized' }
  | { readonly kind: 'conflict' }
  | { readonly kind: 'not-found' }
  | { readonly kind: 'failed'; readonly fault: Fault };
type KeyInput = { readonly brokerUrl: string; readonly deviceId: string; readonly bytes: Uint8Array };
type RequestInput = { readonly session: SessionRecord; readonly id: RequestId };
export interface Broker {
  createSession(input: KeyInput & { readonly name: string }): Promise<Reply<SessionRecord>>;
  keySessions(input: KeyInput): Promise<Reply<readonly SessionSummary[]>>;
  keyRevoke(input: KeyInput & { readonly sessionId: SessionId }): Promise<Reply<void>>;
  sessions(session: SessionRecord): Promise<Reply<readonly SessionSummary[]>>;
  pending(session: SessionRecord, signal?: AbortSignal): Promise<Reply<{ readonly requests: readonly Request[]; readonly unreadable: number }>>;
  request(input: RequestInput): Promise<Reply<Request>>;
  approve(input: RequestInput & { readonly bytes: Uint8Array }): Promise<Reply<void>>;
  deny(input: RequestInput): Promise<Reply<void>>;
  revoke(input: { readonly session: SessionRecord; readonly id: SessionId; readonly bytes?: Uint8Array }): Promise<Reply<void>>;
  events(input: { readonly session: SessionRecord; readonly signal: AbortSignal }): Promise<Reply<ReadableStream<Uint8Array>>>;
}
function failed(kind: Fault['kind']): { readonly kind: 'failed'; readonly fault: Fault } {
  return { kind: 'failed', fault: { kind } };
}
function statusReply(status: number): Exclude<Reply<never>, { kind: 'ok' }> | null {
  if (status >= 200 && status < 300) return null;
  if (status === 401) return { kind: 'unauthorized' };
  if (status === 409) return { kind: 'conflict' };
  if (status === 404) return { kind: 'not-found' };
  return failed(status >= 500 ? 'unavailable' : 'protocol');
}
function mutation(status: 'processed' | 'denied' | 'revoked'): (value: unknown) => Parsed<void> {
  return value => typeof value === 'object' && value !== null && 'status' in value && value.status === status
    ? { kind: 'ok', value: undefined } : { kind: 'protocol' };
}
export function createBroker(environment: Environment): Broker {
  async function send<T>(input: {
    brokerUrl: string; path: string; method?: 'POST'; session?: SessionRecord; body?: string;
    parse: (value: unknown) => Parsed<T>; timeout?: number; signal?: AbortSignal;
  }): Promise<Reply<T>> {
    if (input.signal?.aborted) return failed('network');
    const controller = new AbortController();
    let abort = () => {};
    const aborted = new Promise<Reply<T>>(resolve => {
      abort = () => { controller.abort(); resolve(failed('network')); };
      input.signal?.addEventListener('abort', abort, { once: true });
    });
    let timer: unknown;
    const timeout = new Promise<Reply<T>>(resolve => {
      timer = environment.setTimeout(() => { controller.abort(); resolve(failed('timeout')); }, input.timeout ?? 30_000);
    });
    const operation = async (): Promise<Reply<T>> => {
      try {
        const headers = new Headers();
        if (input.session) headers.set('Authorization', `Bearer ${input.session.viewToken}`);
        if (input.body !== undefined) headers.set('Content-Type', 'application/json');
        const response = await environment.fetch(`${input.brokerUrl}${input.path}`, {
          method: input.method ?? (input.body === undefined ? 'GET' : 'POST'),
          headers, ...(input.body === undefined ? {} : { body: input.body }),
          signal: controller.signal, cache: 'no-store', credentials: 'omit', redirect: 'error',
        });
        if (controller.signal.aborted) return failed('timeout');
        const failure = statusReply(response.status);
        if (failure) return failure;
        let value: unknown;
        try { value = await response.json(); } catch { return failed(controller.signal.aborted ? 'timeout' : 'protocol'); }
        const parsed = input.parse(value);
        return parsed.kind === 'ok' ? { kind: 'ok', value: parsed.value } : failed('protocol');
      } catch { return failed(controller.signal.aborted ? 'timeout' : 'network'); }
    };
    try { return await Promise.race([operation(), timeout, aborted]); }
    finally { environment.clearTimeout(timer); input.signal?.removeEventListener('abort', abort); }
  }
  const devicePath = (deviceId: string) => `/v1/devices/${encodeURIComponent(deviceId)}/sessions`;
  const requestPath = (id: RequestId) => `/v1/requests/${encodeURIComponent(id)}`;
  return {
    createSession(input) {
      return send({ brokerUrl: input.brokerUrl, path: devicePath(input.deviceId), body: keyBody(input),
        parse: value => parseSessionCreated({ value, brokerUrl: input.brokerUrl, deviceId: input.deviceId }) });
    },
    keySessions(input) { return send({ brokerUrl: input.brokerUrl, path: `${devicePath(input.deviceId)}/list`, body: keyBody(input), parse: parseSessionList }); },
    keyRevoke(input) { return send({ brokerUrl: input.brokerUrl, path: `${devicePath(input.deviceId)}/${encodeURIComponent(input.sessionId)}/revoke`, body: keyBody(input), parse: mutation('revoked') }); },
    sessions(session) { return send({ brokerUrl: session.brokerUrl, path: devicePath(session.deviceId), session, parse: parseSessionList }); },
    pending(session, signal) { return send({ brokerUrl: session.brokerUrl, path: '/v1/requests', session, ...(signal === undefined ? {} : { signal }), parse: parsePendingList }); },
    request({ session, id }) { return send({ brokerUrl: session.brokerUrl, path: requestPath(id), session, parse: parseRequest }); },
    approve({ session, id, bytes }) { return send({ brokerUrl: session.brokerUrl, path: `${requestPath(id)}/approve`, session, body: keyBody({ bytes }), parse: mutation('processed'), timeout: 150_000 }); },
    deny({ session, id }) { return send({ brokerUrl: session.brokerUrl, path: `${requestPath(id)}/deny`, method: 'POST', session, parse: mutation('denied') }); },
    revoke({ session, id, bytes }) { return send({ brokerUrl: session.brokerUrl, path: `/v1/sessions/${encodeURIComponent(id)}/revoke`, method: 'POST', session, ...(bytes === undefined ? {} : { body: keyBody({ bytes }) }), parse: mutation('revoked') }); },
    async events({ session, signal }) {
      try {
        const response = await environment.fetch(`${session.brokerUrl}/v1/events`, {
          headers: { Authorization: `Bearer ${session.viewToken}`, Accept: 'text/event-stream' },
          signal, cache: 'no-store', credentials: 'omit', redirect: 'error',
        });
        const failure = statusReply(response.status);
        if (failure) return failure;
        if (response.headers.get('Content-Type')?.split(';')[0]?.trim().toLowerCase() !== 'text/event-stream' || response.body === null) return failed('protocol');
        return { kind: 'ok', value: response.body };
      } catch { return failed('network'); }
    },
  };
}
export async function readEvents(input: {
  stream: ReadableStream<Uint8Array>; signal: AbortSignal;
  onFrame: (kind: 'sync' | 'change' | 'heartbeat') => void;
}): Promise<Fault | null> {
  const reader = input.stream.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let line = '';
  let event = '';
  let hasData = false;
  let frameBytes = 0;
  let afterCr = false;
  function endLine(): void {
    if (line === '') {
      if (hasData && (event === 'sync' || event === 'change')) input.onFrame(event);
      event = ''; hasData = false; frameBytes = 0;
    } else if (line.startsWith(':')) input.onFrame('heartbeat');
    else {
      const colon = line.indexOf(':');
      const field = colon < 0 ? line : line.slice(0, colon);
      let value = colon < 0 ? '' : line.slice(colon + 1);
      if (value.startsWith(' ')) value = value.slice(1);
      if (field === 'event') event = value;
      if (field === 'data') hasData = true;
    }
    line = '';
  }
  function feed(text: string): boolean {
    for (const char of text) {
      if (afterCr && char === '\n') { afterCr = false; continue; }
      afterCr = false;
      const point = char.codePointAt(0) ?? 0;
      frameBytes += point <= 0x7f ? 1 : point <= 0x7ff ? 2 : point <= 0xffff ? 3 : 4;
      if (frameBytes > 65_536) return false;
      if (char === '\r' || char === '\n') { endLine(); afterCr = char === '\r'; }
      else line += char;
    }
    return true;
  }
  const cancel = () => { void reader.cancel().catch(() => {}); };
  input.signal.addEventListener('abort', cancel, { once: true });
  try {
    if (input.signal.aborted) return null;
    while (!input.signal.aborted) {
      let chunk: Awaited<ReturnType<typeof reader.read>>;
      try { chunk = await reader.read(); } catch { return input.signal.aborted ? null : { kind: 'network' }; }
      if (input.signal.aborted) return null;
      try {
        if (!feed(chunk.done ? decoder.decode() : decoder.decode(chunk.value, { stream: true }))) return { kind: 'protocol' };
      } catch { return { kind: 'protocol' }; }
      if (chunk.done) return null;
    }
    return null;
  } finally {
    input.signal.removeEventListener('abort', cancel);
    try { await reader.cancel(); } catch { /* A failed stream still releases its reader. */ }
    reader.releaseLock();
  }
}
