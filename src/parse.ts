import { byDeadline, cautionsOf, leaseOf } from './request.js';
import type { Approval, Binding, CreatedItem, Execution, Instant, ItemField, Operation, Request, RequestId, SecretName, SecretRef, SessionId, SessionSummary, TypeTarget } from './request.js';

export type Parsed<T> = { readonly kind: 'ok'; readonly value: T } | { readonly kind: 'protocol' };
export interface SessionRecord {
  readonly version: 1; readonly brokerUrl: string; readonly deviceId: string; readonly sessionId: SessionId; readonly viewToken: string; readonly viewUntil: Instant;
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function text(value: unknown): string { return typeof value === 'string' ? value : ''; }
function optionalText(value: unknown): string | null { return text(value) || null; }
function strings(value: unknown): string[] { return Array.isArray(value) ? value.filter((entry: unknown): entry is string => typeof entry === 'string') : []; }
function integer(value: unknown, fallback: number): number { return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : fallback; }
function branded<T extends RequestId | SessionId | Instant>(value: string | number): T { return value as T; }
function requestId(value: unknown): RequestId | null { return typeof value === 'string' && value.length > 0 ? branded<RequestId>(value) : null; }
function sessionId(value: unknown): SessionId | null { return typeof value === 'string' && value.length > 0 ? branded<SessionId>(value) : null; }
export function toInstant(value: number): Instant {
  if (!Number.isFinite(value) || Math.abs(value) > 8640000000000000) throw new RangeError('Invalid instant');
  return branded<Instant>(value);
}
export function instant(value: unknown): Instant | null {
  if (typeof value !== 'string' || value === '0001-01-01T00:00:00Z') return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?(Z|[+-]\d{2}:\d{2})$/.exec(value);
  if (!match) return null;
  const year = Number(match[1]), month = Number(match[2]), day = Number(match[3]);
  const hour = Number(match[4]), minute = Number(match[5]), second = Number(match[6]);
  const zone = match[8];
  if (!zone || year < 1 || month < 1 || month > 12 || hour > 23 || minute > 59 || second > 59) return null;
  const days = [31, year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  const maxDay = days[month - 1];
  if (maxDay === undefined || day < 1 || day > maxDay) return null;
  let offset = 0;
  if (zone !== 'Z') {
    const zh = Number(zone.slice(1, 3)), zm = Number(zone.slice(4, 6));
    if (zh > 23 || zm > 59) return null;
    offset = (zh * 60 + zm) * (zone[0] === '+' ? 1 : -1);
  }
  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  date.setUTCHours(hour, minute, second, Number((match[7] ?? '').slice(0, 3).padEnd(3, '0')));
  return toInstant(date.getTime() - offset * 60000);
}
function nameOf(ref: Record<string, unknown>, display: unknown, legacy: boolean): SecretName {
  if (legacy) return { kind: 'legacy' };
  if (!isRecord(display) || display.vault !== ref.vault || display.item !== ref.item || display.field !== ref.field) {
    return { kind: 'unverified', partial: { vault: '', item: '', field: '' } };
  }
  const partial = { vault: text(display.vault_name), item: text(display.item_title), field: text(display.field_label) };
  return display.known === true ? { kind: 'verified', ...partial, fieldType: text(display.field_type), origins: strings(display.origins) } : { kind: 'unverified', partial };
}
function fields(value: unknown): ItemField[] {
  if (!Array.isArray(value)) return [];
  return value.filter(isRecord).map(entry => ({ id: text(entry.id), label: text(entry.label), type: text(entry.type) }));
}
function bindings(value: unknown, secrets: readonly SecretRef[]): Binding[] {
  if (!isRecord(value)) return [];
  return Object.entries(value).map(([name, key]) => ({ name, ref: typeof key === 'string' ? secrets.find(ref => ref.key === key) ?? null : null }));
}
function target(raw: string): TypeTarget {
  const a = raw.indexOf('|'), b = raw.indexOf('|', a + 1), pid = Number(raw.slice(0, a));
  return a > 0 && b > a && /^\d+$/.test(raw.slice(0, a)) && Number.isSafeInteger(pid) && pid > 0
    ? { kind: 'window', pid, app: raw.slice(a + 1, b), title: raw.slice(b + 1) }
    : { kind: 'unparsed', raw };
}
function operationOf(spec: Record<string, unknown>, display: unknown, secrets: readonly SecretRef[]): Operation {
  const kind = text(spec.method);
  switch (kind) {
    case 'reveal': return { kind, outputFormat: optionalText(spec.output_format) };
    case 'otp': case 'clipboard': case 'refresh': return { kind };
    case 'exec': return { kind, command: strings(spec.command), directory: text(spec.directory), env: bindings(spec.bindings, secrets), unmasked: spec.unredacted === true };
    case 'proxy': return { kind, origin: text(spec.origin), header: text(spec.header), prefix: text(spec.prefix), command: strings(spec.command), directory: text(spec.directory), env: bindings(spec.bindings, secrets) };
    case 'type': return { kind, target: target(text(spec.target)) };
    case 'write': {
      const create = isRecord(spec.create) ? spec.create : {};
      return { kind, vaultId: text(create.vault), vaultName: isRecord(display) ? optionalText(display.create_vault_name) : null, title: text(create.title), category: text(create.category), fields: fields(create.fields), passwordRecipe: optionalText(create.generate_password) };
    }
    default: return { kind: 'unrecognized', raw: kind };
  }
}
function approvalOf(value: unknown): Approval {
  switch (value) {
    case 'pending': case 'approved': case 'denied': case 'expired': case 'cancelled': return { kind: value };
    default: return { kind: 'unrecognized', raw: text(value) };
  }
}
function executionOf(value: unknown): Execution {
  switch (value) {
    case 'not_started': return { kind: 'not-started' };
    case 'unknown': return { kind: 'outcome-unknown' };
    case 'running': case 'ready': case 'succeeded': case 'failed': case 'expired': case 'consumed': return { kind: value };
    default: return { kind: 'unrecognized', raw: text(value) };
  }
}
function createdItem(value: unknown): CreatedItem | null {
  return isRecord(value) ? { id: text(value.id), vaultId: text(value.vault), vaultName: optionalText(value.vault_name), title: text(value.title), urls: strings(value.urls), fields: fields(value.fields), fieldsKnown: value.fields_known === true, syncedAt: instant(value.synced_at) } : null;
}
export function parseRequest(value: unknown): Parsed<Request> {
  if (!isRecord(value) || !isRecord(value.spec)) return { kind: 'protocol' };
  const id = requestId(value.id), createdAt = instant(value.created_at), deadline = instant(value.deadline), spec = value.spec;
  if (!id || createdAt === null || deadline === null || typeof spec.method !== 'string' || !spec.method) return { kind: 'protocol' };
  const displayRefs = isRecord(value.display) && Array.isArray(value.display.refs) ? value.display.refs : [];
  const secrets: SecretRef[] = [];
  if (spec.refs !== undefined && !Array.isArray(spec.refs)) return { kind: 'protocol' };
  if (Array.isArray(spec.refs)) {
    for (const [index, ref] of spec.refs.entries()) {
      if (!isRecord(ref) || typeof ref.vault !== 'string' || typeof ref.item !== 'string' || typeof ref.field !== 'string') return { kind: 'protocol' };
      secrets.push({ key: `${ref.vault}/${ref.item}/${ref.field}`, vaultId: ref.vault, itemId: ref.item, fieldId: ref.field, name: nameOf(ref, displayRefs[index], value.display === undefined || value.display === null) });
    }
  }
  const operation = operationOf(spec, value.display, secrets), lease = leaseOf(integer(spec.ttl_seconds, 0), integer(spec.uses, 1));
  return { kind: 'ok', value: { id, agent: optionalText(spec.agent), reason: text(spec.reason), source: text(value.source), secrets, operation, lease, cautions: cautionsOf(operation, secrets, lease), createdAt, deadline, approval: approvalOf(value.approval), execution: executionOf(value.execution), approvedAt: instant(value.approved_at), approvedBy: optionalText(value.approved_by), approvedSession: optionalText(value.approved_session), leaseUntil: instant(value.lease_until), used: integer(value.used, 0), receiptUntil: instant(value.receipt_until), createdItem: createdItem(value.created_item) } };
}
export function parsePendingList(value: unknown): Parsed<{ readonly requests: readonly Request[]; readonly unreadable: number }> {
  if (!Array.isArray(value)) return { kind: 'protocol' };
  const requests: Request[] = []; let unreadable = 0;
  for (const entry of value) {
    const parsed = parseRequest(entry);
    if (parsed.kind === 'protocol') unreadable++;
    else if (parsed.value.approval.kind === 'pending') requests.push(parsed.value);
  }
  return { kind: 'ok', value: { requests: requests.sort(byDeadline), unreadable } };
}
export function normalizeBrokerUrl(value: string): string | null {
  try {
    const url = new URL(value);
    if ((url.protocol !== 'https:' && url.protocol !== 'http:') || url.username || url.password || url.search || url.hash || (url.pathname !== '/' && url.pathname !== '')) return null;
    // The device key travels in request bodies. Plaintext is allowed only where the broker's --dev mode can listen: numeric loopback.
    if (url.protocol === 'http:' && !/^127(?:\.\d{1,3}){3}$/.test(url.hostname) && url.hostname !== '[::1]') return null;
    return url.origin;
  } catch { return null; }
}
export function parseSessionCreated(input: { value: unknown; brokerUrl: string; deviceId: string }): Parsed<SessionRecord> {
  const { value, deviceId } = input, brokerUrl = normalizeBrokerUrl(input.brokerUrl);
  if (!isRecord(value) || !brokerUrl || !deviceId) return { kind: 'protocol' };
  const id = sessionId(value.session_id), viewToken = optionalText(value.view_token), viewUntil = instant(value.view_until);
  if (!id || !viewToken || viewUntil === null || value.id !== deviceId) return { kind: 'protocol' };
  return { kind: 'ok', value: { version: 1, brokerUrl, deviceId, sessionId: id, viewToken, viewUntil } };
}
export function parseSessionList(value: unknown): Parsed<readonly SessionSummary[]> {
  if (!Array.isArray(value)) return { kind: 'protocol' };
  const result: SessionSummary[] = [];
  for (const entry of value) {
    if (!isRecord(entry)) continue;
    const id = sessionId(entry.session_id), createdAt = instant(entry.created_at), viewUntil = instant(entry.view_until);
    if (id && createdAt !== null && viewUntil !== null && typeof entry.name === 'string' && typeof entry.current === 'boolean') result.push({ sessionId: id, name: entry.name, createdAt, viewUntil, current: entry.current });
  }
  return { kind: 'ok', value: result };
}
export function parseSavedSession(value: string): Parsed<SessionRecord> {
  let parsed: unknown;
  try { parsed = JSON.parse(value); } catch { return { kind: 'protocol' }; }
  if (!isRecord(parsed) || parsed.version !== 1 || typeof parsed.brokerUrl !== 'string' || typeof parsed.deviceId !== 'string' || !parsed.deviceId) return { kind: 'protocol' };
  const brokerUrl = normalizeBrokerUrl(parsed.brokerUrl), id = sessionId(parsed.sessionId), viewToken = optionalText(parsed.viewToken);
  if (!brokerUrl || !id || !viewToken || typeof parsed.viewUntil !== 'number' || !Number.isFinite(parsed.viewUntil) || Math.abs(parsed.viewUntil) > 8640000000000000) return { kind: 'protocol' };
  return { kind: 'ok', value: { version: 1, brokerUrl, deviceId: parsed.deviceId, sessionId: id, viewToken, viewUntil: toInstant(parsed.viewUntil) } };
}
export function encodeSavedSession(value: SessionRecord): string {
  return JSON.stringify({ version: 1, brokerUrl: value.brokerUrl, deviceId: value.deviceId, sessionId: value.sessionId, viewToken: value.viewToken, viewUntil: value.viewUntil });
}
