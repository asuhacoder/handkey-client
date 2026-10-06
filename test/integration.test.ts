import { execFile, spawn } from 'node:child_process';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { expect, test } from 'vitest';
import { createHandkey } from '../src/handkey.js';
import { consumeDeviceKey } from '../src/key.js';
import { parseRequest, parseSessionList } from '../src/parse.js';

const execute = promisify(execFile);
const binary = process.env.HANDKEY_BIN;
const keyText = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';

function key(text = keyText) {
 const result = consumeDeviceKey(text);
 if (result === null) throw new Error('Invalid integration fixture key');
 return result;
}

function object(value: unknown): value is Record<string, unknown> {
 return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function credentials(value: unknown) {
 if (!object(value) || typeof value.id !== 'string' || !value.id || typeof value.view_token !== 'string' || !value.view_token) {
  throw new Error('Invalid bootstrap credentials');
 }
 return { deviceId: value.id, token: value.view_token };
}

test.skipIf(binary === undefined)('real broker sessions, SSE, approvals, denial and sign-out', async () => {
 if (binary === undefined || !isAbsolute(binary)) throw new Error('HANDKEY_BIN must be an absolute path');
 const executable = binary;
 const scratch = fileURLToPath(new URL('../.it/', import.meta.url));
 await mkdir(join(scratch, 'tmp'), { recursive: true });
 const directory = await mkdtemp(join(scratch, 'tmp', 'it-'));
 const op = join(directory, 'op');
 await writeFile(op, `#!/bin/sh
case "$3" in
 get) printf '{"id":"%s","title":"Fixture","vault":{"id":"%s","name":"Fixture vault"},"fields":[{"id":"password","label":"Password","type":"CONCEALED","value":"fixture-secret"}]}' "$4" "$6" ;;
 list) printf '[]' ;;
 *) exit 1 ;;
esac
`, { mode: 0o700 });
 const socket = join(directory, 's');
 const childEnvironment = { ...process.env, HOME: directory, TMPDIR: directory, XDG_CONFIG_HOME: directory, XDG_CACHE_HOME: directory };
 const server = spawn(executable, ['serve', '--dev', '--bootstrap', '--state-dir', join(directory, 'state'), '--op', op, '--socket', socket, '--listen', '127.0.0.1:0'], {
  cwd: directory, env: childEnvironment, stdio: ['ignore', 'pipe', 'pipe'],
 });
 let output = '';
 let errors = '';
 server.stdout.on('data', (chunk: Buffer) => { output += chunk.toString(); });
 server.stderr.on('data', (chunk: Buffer) => { errors += chunk.toString(); });
 const exited = new Promise<void>((resolveExit, rejectExit) => {
  server.once('error', rejectExit);
  server.once('close', () => resolveExit());
 });
 const actor = createHandkey();
 const administrator = createHandkey();
 let unsubscribe = () => {};
 try {
  await expect.poll(() => {
   if (server.exitCode !== null) throw new Error(`Broker exited: ${errors}`);
   return output.includes('Approval endpoint: http://');
  }, { timeout: 10_000 }).toBe(true);
  const endpoint = /Approval endpoint: (http:\/\/127\.0\.0\.1:\d+)/.exec(output)?.[1];
  if (endpoint === undefined) throw new Error('Missing broker endpoint');
  const bootstrap = await fetch(`${endpoint}/v1/bootstrap`, {
   method: 'POST', headers: { 'Content-Type': 'application/json' },
   body: JSON.stringify({ name: 'it-device', session_name: 'boot', key: keyText, service_account_token: 'fixture' }),
  });
  expect(bootstrap.status).toBe(201);
  const rawCredentials: unknown = await bootstrap.json();
  const { deviceId, token } = credentials(rawCredentials);
  const sessionResponse = await fetch(`${endpoint}/v1/devices/${deviceId}/sessions`, { headers: { Authorization: `Bearer ${token}` } });
  expect(sessionResponse.status).toBe(200);
  const rawSessions: unknown = await sessionResponse.json();
  const sessions = parseSessionList(rawSessions);
  if (sessions.kind !== 'ok') throw new Error('Invalid bootstrap session list');
  const boot = sessions.value.find(session => session.name === 'boot');
  if (boot === undefined) throw new Error('Missing bootstrap session');

  expect(await administrator.listSessionsWithKey({ brokerUrl: endpoint, deviceId, key: key() })).toMatchObject({ kind: 'ok', value: [{ name: 'boot', current: false }] });
  expect(await administrator.listSessionsWithKey({ brokerUrl: endpoint, deviceId, key: key('AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE') })).toEqual({ kind: 'rejected' });
  expect(administrator.getSnapshot()).toMatchObject({ kind: 'register', reason: 'never-registered' });

  expect(await actor.register({ brokerUrl: endpoint, deviceId, name: 'integration', key: key() })).toEqual({ kind: 'registered', persistence: 'saved' });
  unsubscribe = actor.subscribe(() => {});
  await expect.poll(() => {
   const snapshot = actor.getSnapshot();
   return snapshot.kind === 'active' ? snapshot.connection : snapshot.kind;
  }).toBe('live');

  async function submit(reason: string) {
   const spec = join(directory, `${reason}.json`);
   await writeFile(spec, JSON.stringify({ method: 'reveal', reason, refs: [{ vault: 'aaaaaaaaaaaaaaaaaaaaaaaaaa', item: 'bbbbbbbbbbbbbbbbbbbbbbbbbb', field: 'password' }] }));
   const result = await execute(executable, ['request', '--endpoint', `unix://${socket}`, '--in-file', spec, '--no-wait', '--receipt', join(directory, `${reason}-receipt.json`)], { cwd: directory, env: childEnvironment });
   const receipt: unknown = JSON.parse(result.stdout);
   if (!object(receipt) || typeof receipt.id !== 'string' || !receipt.id) throw new Error('Invalid CLI receipt');
   const response = await fetch(`${endpoint}/v1/requests/${receipt.id}`, { headers: { Authorization: `Bearer ${token}` } });
   expect(response.status).toBe(200);
   const raw: unknown = await response.json();
   const parsed = parseRequest(raw);
   if (parsed.kind !== 'ok') throw new Error('Invalid submitted request');
   await expect.poll(() => {
    const snapshot = actor.getSnapshot();
    return snapshot.kind === 'active' && snapshot.pending.some(request => request.id === parsed.value.id);
   }).toBe(true);
   return parsed.value.id;
  }

  const approvedId = await submit('approve');
  const approval = await actor.approve([approvedId], key());
  expect(approval).toMatchObject({ kind: 'finished', stopped: null, items: [{ id: approvedId, outcome: { kind: 'executed', request: { approval: { kind: 'approved' }, execution: { kind: 'ready' } } } }] });
  expect(await actor.inspect(approvedId)).toMatchObject({ kind: 'ok', value: { reason: 'approve', approval: { kind: 'approved' }, execution: { kind: 'ready' } } });
  const deniedId = await submit('deny');
  expect(await actor.deny([deniedId])).toEqual({ kind: 'finished', items: [{ id: deniedId, outcome: { kind: 'denied' } }], stopped: null });
  expect(await actor.inspect(deniedId)).toMatchObject({ kind: 'ok', value: { reason: 'deny', approval: { kind: 'denied' } } });
  await expect.poll(() => {
   const snapshot = actor.getSnapshot();
   return snapshot.kind === 'active' ? snapshot.pending : null;
  }).toEqual([]);

  expect(await administrator.revokeSessionWithKey({ brokerUrl: endpoint, deviceId, sessionId: boot.sessionId, key: key() })).toEqual({ kind: 'ok' });
  expect(await administrator.revokeSessionWithKey({ brokerUrl: endpoint, deviceId, sessionId: boot.sessionId, key: key() })).toEqual({ kind: 'not-found' });
  expect(administrator.getSnapshot()).toMatchObject({ kind: 'register', reason: 'never-registered' });
  await actor.signOut();
  expect(actor.getSnapshot()).toMatchObject({ kind: 'register', reason: 'signed-out' });
  const remaining = await administrator.listSessionsWithKey({ brokerUrl: endpoint, deviceId, key: key() });
  expect(remaining).toEqual({ kind: 'ok', value: [] });
 } finally {
  unsubscribe();
  server.kill('SIGINT');
  await exited;
 }
}, 30_000);
