import { describe, expect, it } from 'vitest';
import { encodeSavedSession, instant, normalizeBrokerUrl, parsePendingList, parseRequest, parseSavedSession, parseSessionCreated, parseSessionList, toInstant } from '../src/parse.js';

const ref = {
  key: 'v/i/password', vaultId: 'v', itemId: 'i', fieldId: 'password',
  name: { kind: 'verified', vault: 'Main <vault>', item: 'Example & item', field: 'Password', fieldType: 'CONCEALED', origins: ['https://example.com:8443'] },
};
const base = {
  id: 'legacy-request', agent: '<agent>', reason: 'Read <untrusted> text', source: '@local',
  secrets: [ref], lease: { kind: 'single-use' }, createdAt: 1704067200000, deadline: 1704067260000,
  approval: { kind: 'pending' }, execution: { kind: 'not-started' }, approvedAt: null,
  approvedBy: null, approvedSession: null, leaseUntil: null, used: 0, receiptUntil: null, createdItem: null,
};
function wire(spec: Record<string, unknown> = {}, extra: Record<string, unknown> = {}): unknown {
  const result: unknown = JSON.parse(JSON.stringify({
    id: 'legacy-request', spec: { method: 'otp', refs: [{ vault: 'v', item: 'i', field: 'password' }], reason: 'Read <untrusted> text', agent: '<agent>', ttl_seconds: 0, uses: 1, wait_seconds: 30, ...spec },
    display: { refs: [{ vault: 'v', item: 'i', field: 'password', vault_name: 'Main <vault>', item_title: 'Example & item', field_label: 'Password', field_type: 'CONCEALED', origins: ['https://example.com:8443'], known: true }] },
    approval: 'pending', execution: 'not_started', created_at: '2024-01-01T00:00:00Z', deadline: '2024-01-01T00:01:00Z', approved_at: '0001-01-01T00:00:00Z', lease_until: '0001-01-01T00:00:00Z', receipt_until: '0001-01-01T00:00:00Z', used: 0, source: '@local', ...extra,
  }));
  return result;
}

describe('full request JSON', () => {
  it.each([
    { method: 'reveal', spec: { output_format: 'json' }, operation: { kind: 'reveal', outputFormat: 'json' }, cautions: ['value-reaches-model'] },
    { method: 'otp', spec: {}, operation: { kind: 'otp' }, cautions: [] },
    { method: 'exec', spec: { command: ['sh', '-c', 'echo <text>'], directory: '/work', bindings: { TOKEN: 'v/i/password', MISSING: 'v/missing/password' }, unredacted: true }, operation: { kind: 'exec', command: ['sh', '-c', 'echo <text>'], directory: '/work', env: [{ name: 'TOKEN', ref }, { name: 'MISSING', ref: null }], unmasked: true }, cautions: ['output-unmasked'] },
    { method: 'proxy', spec: { origin: 'https://api.example', header: 'Authorization', prefix: 'Bearer ', command: ['curl', '/endpoint'], directory: '/tmp', bindings: { 'X-Key': 'v/i/password' } }, operation: { kind: 'proxy', origin: 'https://api.example', header: 'Authorization', prefix: 'Bearer ', command: ['curl', '/endpoint'], directory: '/tmp', env: [{ name: 'X-Key', ref }] }, cautions: [] },
    { method: 'type', spec: { target: '42|Editor|Window | title | suffix' }, operation: { kind: 'type', target: { kind: 'window', pid: 42, app: 'Editor', title: 'Window | title | suffix' } }, cautions: [] },
    { method: 'clipboard', spec: {}, operation: { kind: 'clipboard' }, cautions: ['clipboard-persists'] },
    { method: 'write', spec: { create: { vault: 'v', title: 'New <item>', category: 'LOGIN', generate_password: 'letters,digits,32', fields: [{ id: 'password', label: 'Password', type: 'CONCEALED', value: 'never-visible' }] } }, operation: { kind: 'write', vaultId: 'v', vaultName: null, title: 'New <item>', category: 'LOGIN', fields: [{ id: 'password', label: 'Password', type: 'CONCEALED' }], passwordRecipe: 'letters,digits,32' }, cautions: ['values-not-reviewable'] },
    { method: 'refresh', spec: {}, operation: { kind: 'refresh' }, cautions: [] },
  ])('parses $method into a literal domain object', ({ method, spec, operation, cautions }) => {
    expect(parseRequest(wire({ ...spec, method }))).toEqual({ kind: 'ok', value: { ...base, operation, cautions } });
  });

  it('keeps absent display names legacy and emits names-unverified', () => {
    expect(parseRequest(wire({}, { display: undefined }))).toEqual({ kind: 'ok', value: { ...base, secrets: [{ key: 'v/i/password', vaultId: 'v', itemId: 'i', fieldId: 'password', name: { kind: 'legacy' } }], operation: { kind: 'otp' }, cautions: ['names-unverified'] } });
  });
  it('preserves known false partial labels but never treats them as verified', () => {
    expect(parseRequest(wire({}, { display: { refs: [{ vault: 'v', item: 'i', field: 'password', vault_name: 'Main', item_title: 'Example', field_label: '', known: false }] } }))).toEqual({ kind: 'ok', value: { ...base, secrets: [{ key: 'v/i/password', vaultId: 'v', itemId: 'i', fieldId: 'password', name: { kind: 'unverified', partial: { vault: 'Main', item: 'Example', field: '' } } }], operation: { kind: 'otp' }, cautions: ['names-unverified'] } });
  });
  it.each(['vault', 'item', 'field'])('discards display labels when the %s identity mismatches', (identity) => {
    expect(parseRequest(wire({}, { display: { refs: [{ vault: 'v', item: 'i', field: 'password', [identity]: 'wrong', vault_name: 'Wrong vault', item_title: 'Wrong item', field_label: 'Wrong field', known: true }] } }))).toEqual({ kind: 'ok', value: { ...base, secrets: [{ key: 'v/i/password', vaultId: 'v', itemId: 'i', fieldId: 'password', name: { kind: 'unverified', partial: { vault: '', item: '', field: '' } } }], operation: { kind: 'otp' }, cautions: ['names-unverified'] } });
  });
  it('resolves binding names against canonical refs and retains exact ref identity', () => {
    const result = parseRequest(wire({ method: 'exec', command: ['env'], directory: '/work', bindings: { TOKEN: 'v/i/password', WRONG: 'other/i/password' } }));
    expect(result).toEqual({ kind: 'ok', value: { ...base, operation: { kind: 'exec', command: ['env'], directory: '/work', env: [{ name: 'TOKEN', ref }, { name: 'WRONG', ref: null }], unmasked: false }, cautions: [] } });
    if (result.kind !== 'ok' || result.value.operation.kind !== 'exec') throw new Error('Expected exec request');
    expect(result.value.operation.env[0]?.ref).toBe(result.value.secrets[0]);
  });
  it('does not search other positions to verify reordered display refs', () => {
    expect(parseRequest(wire({ refs: [{ vault: 'v', item: 'i', field: 'username' }, { vault: 'v', item: 'i', field: 'password' }] }, { display: { refs: [{ vault: 'v', item: 'i', field: 'password', known: true }, { vault: 'v', item: 'i', field: 'username', known: true }] } }))).toEqual({ kind: 'ok', value: { ...base, secrets: [
      { key: 'v/i/username', vaultId: 'v', itemId: 'i', fieldId: 'username', name: { kind: 'unverified', partial: { vault: '', item: '', field: '' } } },
      { key: 'v/i/password', vaultId: 'v', itemId: 'i', fieldId: 'password', name: { kind: 'unverified', partial: { vault: '', item: '', field: '' } } },
    ], operation: { kind: 'otp' }, cautions: ['names-unverified'] } });
  });
  it('preserves unknown method, approval and execution strings and keeps the list readable', () => {
    expect(parseRequest(wire({ method: 'future-method' }, { approval: 'future-approval', execution: 'future-execution' }))).toEqual({ kind: 'ok', value: { ...base, operation: { kind: 'unrecognized', raw: 'future-method' }, approval: { kind: 'unrecognized', raw: 'future-approval' }, execution: { kind: 'unrecognized', raw: 'future-execution' }, cautions: [] } });
    expect(parsePendingList([wire({ method: 'future-method' }, { execution: 'future-execution' }), wire({}, { approval: 'future-approval' })])).toEqual({ kind: 'ok', value: { requests: [{ ...base, operation: { kind: 'unrecognized', raw: 'future-method' }, execution: { kind: 'unrecognized', raw: 'future-execution' }, cautions: [] }], unreadable: 0 } });
  });
  it('ignores extra fields and strips create and created-item field values', () => {
    expect(parseRequest(wire({ method: 'write', future: true, create: { vault: 'v', title: 't', category: 'LOGIN', future: true, fields: [{ id: 'p', label: 'Password', type: 'CONCEALED', value: 'secret-value', future: true }] } }, { future: true, display: { refs: [], create_vault_name: 'Main', future: true }, created_item: { id: 'new', vault: 'v', vault_name: 'Main', title: 't', urls: ['https://example.com/path'], fields: [{ id: 'p', label: 'Password', type: 'CONCEALED', value: 'also-secret', future: true }], fields_known: true, synced_at: '2024-01-01T00:00:00.123456789Z', future: true } }))).toEqual({ kind: 'ok', value: { ...base,
      secrets: [{ key: 'v/i/password', vaultId: 'v', itemId: 'i', fieldId: 'password', name: { kind: 'unverified', partial: { vault: '', item: '', field: '' } } }],
      operation: { kind: 'write', vaultId: 'v', vaultName: 'Main', title: 't', category: 'LOGIN', fields: [{ id: 'p', label: 'Password', type: 'CONCEALED' }], passwordRecipe: null }, cautions: ['values-not-reviewable', 'names-unverified'],
      createdItem: { id: 'new', vaultId: 'v', vaultName: 'Main', title: 't', urls: ['https://example.com/path'], fields: [{ id: 'p', label: 'Password', type: 'CONCEALED' }], fieldsKnown: true, syncedAt: 1704067200123 },
    } });
  });
  it.each(['pending', 'approved', 'denied', 'expired', 'cancelled'])('preserves approval state %s', (kind) => {
    expect(parseRequest(wire({}, { approval: kind }))).toEqual({ kind: 'ok', value: { ...base, operation: { kind: 'otp' }, cautions: [], approval: { kind } } });
  });
  it.each([
    ['not_started', 'not-started'], ['running', 'running'], ['ready', 'ready'], ['succeeded', 'succeeded'],
    ['failed', 'failed'], ['unknown', 'outcome-unknown'], ['expired', 'expired'], ['consumed', 'consumed'],
  ])('preserves execution state %s', (raw, kind) => {
    expect(parseRequest(wire({}, { execution: raw }))).toEqual({ kind: 'ok', value: { ...base, operation: { kind: 'otp' }, cautions: [], execution: { kind } } });
  });
  it('maps malformed optional timestamps to null without losing required times', () => {
    expect(parseRequest(wire({}, { approved_at: '2024-02-30T00:00:00Z', lease_until: false, receipt_until: 'not-time' }))).toEqual({ kind: 'ok', value: { ...base, operation: { kind: 'otp' }, cautions: [] } });
  });
  it('parses refresh without refs and emits no name caution', () => {
    expect(parseRequest(wire({ method: 'refresh', refs: undefined }, { display: { refs: [] } }))).toEqual({ kind: 'ok', value: { ...base, secrets: [], operation: { kind: 'refresh' }, cautions: [] } });
  });
  it('parses decision metadata and maps broker unknown execution to outcome-unknown', () => {
    expect(parseRequest(wire({}, { approval: 'denied', execution: 'unknown', approved_at: '2024-01-01T00:00:10Z', approved_by: 'legacy-device', approved_session: 'legacy-session', lease_until: '2024-01-01T00:00:30Z', receipt_until: '2024-01-01T00:00:40Z', used: 2 }))).toEqual({ kind: 'ok', value: { ...base, operation: { kind: 'otp' }, cautions: [], approval: { kind: 'denied' }, execution: { kind: 'outcome-unknown' }, approvedAt: 1704067210000, approvedBy: 'legacy-device', approvedSession: 'legacy-session', leaseUntil: 1704067230000, receiptUntil: 1704067240000, used: 2 } });
  });
  it.each(['pid|App|Title', '0|App|Title', '-1|App|Title', '1.5|App|Title', '9007199254740992|App|Title', '42|App', ''])('keeps invalid target %j unparsed', (raw) => {
    expect(parseRequest(wire({ method: 'type', target: raw }))).toEqual({ kind: 'ok', value: { ...base, operation: { kind: 'type', target: { kind: 'unparsed', raw } }, cautions: [] } });
  });
  it.each([
    { ttl: 0, uses: 0, lease: { kind: 'single-use' }, cautions: [] },
    { ttl: 0, uses: 1, lease: { kind: 'single-use' }, cautions: [] },
    { ttl: 0, uses: 3, lease: { kind: 'window', seconds: 900, maxUses: 3 }, cautions: ['multiple-uses'] },
    { ttl: 3599, uses: 1, lease: { kind: 'window', seconds: 3599, maxUses: 1 }, cautions: [] },
    { ttl: 3600, uses: 1, lease: { kind: 'window', seconds: 3600, maxUses: 1 }, cautions: ['long-lease'] },
    { ttl: 86400, uses: 4, lease: { kind: 'window', seconds: 86400, maxUses: 4 }, cautions: ['long-lease', 'multiple-uses'] },
  ])('shapes ttl $ttl and uses $uses into lease and cautions', ({ ttl, uses, lease, cautions }) => {
    expect(parseRequest(wire({ ttl_seconds: ttl, uses }))).toEqual({ kind: 'ok', value: { ...base, operation: { kind: 'otp' }, lease, cautions } });
  });
  it('combines method, name and lease cautions', () => {
    expect(parseRequest(wire({ method: 'reveal', ttl_seconds: 3600, uses: 2 }, { display: null }))).toEqual({ kind: 'ok', value: { ...base, secrets: [{ key: 'v/i/password', vaultId: 'v', itemId: 'i', fieldId: 'password', name: { kind: 'legacy' } }], operation: { kind: 'reveal', outputFormat: null }, lease: { kind: 'window', seconds: 3600, maxUses: 2 }, cautions: ['value-reaches-model', 'names-unverified', 'long-lease', 'multiple-uses'] } });
  });
  it('counts malformed required entries and sorts surviving pending requests by deadline then id', () => {
    expect(parsePendingList([wire({}, { id: 'z', deadline: '2024-01-01T00:02:00Z' }), wire({}, { id: 'b' }), wire({}, { id: 'a' }), wire({}, { id: '' }), wire({}, { deadline: '2024-02-30T00:00:00Z' }), wire({ refs: [{ vault: 'v', item: 1, field: 'p' }] }), wire({ method: '' }), null, wire({}, { approval: 'approved' })])).toEqual({ kind: 'ok', value: { requests: [
      { ...base, id: 'a', operation: { kind: 'otp' }, cautions: [] }, { ...base, id: 'b', operation: { kind: 'otp' }, cautions: [] }, { ...base, id: 'z', deadline: 1704067320000, operation: { kind: 'otp' }, cautions: [] },
    ], unreadable: 5 } });
  });
  it('rejects malformed roots and parses omitted optional fields with zero times null', () => {
    for (const value of [null, [], {}, { spec: {} }, wire({ refs: 'bad' }), wire({}, { created_at: '0001-01-01T00:00:00Z' })]) expect(parseRequest(value)).toEqual({ kind: 'protocol' });
    expect(parsePendingList({ requests: [] })).toEqual({ kind: 'protocol' });
    expect(parseRequest(wire({ refs: undefined, agent: undefined, reason: '' }, { display: undefined, approved_at: undefined, lease_until: undefined, receipt_until: undefined }))).toEqual({ kind: 'ok', value: { ...base, agent: null, reason: '', secrets: [], operation: { kind: 'otp' }, cautions: [] } });
  });
});

describe('strict RFC3339', () => {
  it.each([
    ['1970-01-01T00:00:00Z', 0], ['2000-02-29T00:00:00Z', 951782400000], ['2024-02-29T00:00:00Z', 1709164800000],
    ['2024-01-01T09:00:00+09:00', 1704067200000], ['2023-12-31T18:30:00-05:30', 1704067200000],
    ['2024-01-01T00:00:00.1Z', 1704067200100], ['2024-01-01T00:00:00.123456789Z', 1704067200123],
    ['2024-01-01T23:59:00+23:59', 1704067200000], ['0001-01-01T00:00:00.001Z', -62135596799999],
  ])('parses %s into literal milliseconds', (value, expected) => { expect(instant(value)).toBe(expected); });
  it.each([
    '0001-01-01T00:00:00Z', '0000-01-01T00:00:00Z', '1900-02-29T00:00:00Z', '2023-02-29T00:00:00Z',
    '2024-00-01T00:00:00Z', '2024-13-01T00:00:00Z', '2024-01-00T00:00:00Z', '2024-01-32T00:00:00Z',
    '2024-04-31T00:00:00Z', '2024-06-31T00:00:00Z', '2024-09-31T00:00:00Z', '2024-11-31T00:00:00Z',
    '2024-01-01T24:00:00Z', '2024-01-01T00:60:00Z', '2024-01-01T00:00:60Z', '2024-01-01T00:00:00+24:00',
    '2024-01-01T00:00:00-00:60', '2024-01-01T00:00:00+0900', '2024-1-01T00:00:00Z', '2024-01-01 00:00:00Z',
    '2024-01-01t00:00:00z', '2024-01-01T00:00:00', '2024-01-01T00:00:00.Z', '2024-01-01T00:00:00Z trailing', '', null, 1704067200000,
  ])('rejects invalid %j with a positive control', (value) => {
    expect(instant(value)).toBeNull();
    expect(instant('1970-01-01T00:00:00Z')).toBe(0);
  });
});

describe('sessions, broker URLs and saved records', () => {
  const saved = '{"version":1,"brokerUrl":"https://broker.example","deviceId":"legacy-device","sessionId":"legacy-session","viewToken":"view-old","viewUntil":1704067200000}';
  const session = { version: 1, brokerUrl: 'https://broker.example', deviceId: 'legacy-device', sessionId: 'legacy-session', viewToken: 'view-old', viewUntil: 1704067200000 };
  it('parses created credentials and permits legacy identifiers', () => {
    expect(parseSessionCreated({ brokerUrl: 'https://BROKER.example:443/', deviceId: 'legacy-device', value: { id: 'legacy-device', session_id: 'legacy-session', view_token: 'view-old', view_until: '2024-01-01T09:00:00+09:00', extra: true } })).toEqual({ kind: 'ok', value: session });
    for (const value of [null, { id: 'wrong', session_id: 'legacy-session', view_token: 'view-old', view_until: '2024-01-01T00:00:00Z' }, { id: 'legacy-device', session_id: '', view_token: 'view-old', view_until: '2024-01-01T00:00:00Z' }, { id: 'legacy-device', session_id: 'legacy-session', view_token: '', view_until: '2024-01-01T00:00:00Z' }, { id: 'legacy-device', session_id: 'legacy-session', view_token: 'view-old', view_until: '0001-01-01T00:00:00Z' }]) expect(parseSessionCreated({ brokerUrl: 'https://broker.example', deviceId: 'legacy-device', value })).toEqual({ kind: 'protocol' });
  });
  it('keeps server session order and skips malformed summaries', () => {
    expect(parseSessionList([
      { session_id: 'b', name: '<phone>', created_at: '2024-01-01T00:00:00Z', view_until: '2024-01-01T00:01:00Z', current: false, extra: true }, null,
      { session_id: 'bad', name: 'bad', created_at: '2024-02-30T00:00:00Z', view_until: '2024-01-01T00:01:00Z', current: true },
      { session_id: 'a', name: '', created_at: '2024-01-01T00:00:10Z', view_until: '2024-01-01T00:02:00Z', current: true },
      { session_id: 'bad', name: '', created_at: '2024-01-01T00:00:00Z', view_until: '2024-01-01T00:01:00Z', current: 'true' },
    ])).toEqual({ kind: 'ok', value: [{ sessionId: 'b', name: '<phone>', createdAt: 1704067200000, viewUntil: 1704067260000, current: false }, { sessionId: 'a', name: '', createdAt: 1704067210000, viewUntil: 1704067320000, current: true }] });
    expect(parseSessionList({ sessions: [] })).toEqual({ kind: 'protocol' });
  });
  it.each([['https://BROKER.example:443/', 'https://broker.example'], ['http://localhost:8080/', 'http://localhost:8080'], ['https://[::1]:8443', 'https://[::1]:8443']])('normalizes %s', (input, expected) => { expect(normalizeBrokerUrl(input)).toBe(expected); });
  it.each(['ftp://broker.example', 'https://user:pass@broker.example', 'https://user@broker.example', 'https://broker.example/v1', 'https://broker.example/?q=x', 'https://broker.example/#fragment', 'not a url', ''])('rejects unsafe URL %s with a positive control', (input) => {
    expect(normalizeBrokerUrl(input)).toBeNull();
    expect(normalizeBrokerUrl('https://broker.example/')).toBe('https://broker.example');
  });
  it('parses saved JSON and encodes only persistence fields', () => {
    expect(parseSavedSession(saved)).toEqual({ kind: 'ok', value: session });
    const parsed = parseSessionCreated({ value: { id: 'legacy-device', session_id: 'legacy-session', view_token: 'view-old', view_until: '2024-01-01T00:00:00Z' }, brokerUrl: 'https://broker.example', deviceId: 'legacy-device' });
    if (parsed.kind !== 'ok') throw new Error('Expected session');
    expect(encodeSavedSession(parsed.value)).toBe(saved);
    expect(parseSavedSession('{"version":1,"brokerUrl":"https://BROKER.example/","deviceId":"legacy-device","sessionId":"legacy-session","viewToken":"view-old","viewUntil":1704067200000,"extra":"ignored"}')).toEqual({ kind: 'ok', value: session });
  });
  it.each(['{', 'null', '[]', '{}', '{"version":2}',
    '{"version":1,"brokerUrl":"https://broker.example","deviceId":"","sessionId":"s","viewToken":"v","viewUntil":0}',
    '{"version":1,"brokerUrl":"https://broker.example/path","deviceId":"d","sessionId":"s","viewToken":"v","viewUntil":0}',
    '{"version":1,"brokerUrl":"https://broker.example","deviceId":"d","sessionId":"","viewToken":"v","viewUntil":0}',
    '{"version":1,"brokerUrl":"https://broker.example","deviceId":"d","sessionId":"s","viewToken":"","viewUntil":0}',
    '{"version":1,"brokerUrl":"https://broker.example","deviceId":"d","sessionId":"s","viewToken":"v","viewUntil":"2024-01-01T00:00:00Z"}',
    '{"version":1,"brokerUrl":"https://broker.example","deviceId":"d","sessionId":"s","viewToken":"v","viewUntil":1e400}',
    '{"version":1,"brokerUrl":"https://broker.example","deviceId":"d","sessionId":"s","viewToken":"v","viewUntil":8640000000000001}',
  ])('rejects malformed saved record %s', (value) => {
    expect(parseSavedSession(value)).toEqual({ kind: 'protocol' });
    expect(parseSavedSession(saved)).toEqual({ kind: 'ok', value: session });
  });
  it('validates numeric instants at the Date boundary', () => {
    expect(toInstant(0)).toBe(0);
    expect(toInstant(8640000000000000)).toBe(8640000000000000);
    for (const value of [NaN, Infinity, -Infinity, 8640000000000001, -8640000000000001]) expect(() => toInstant(value)).toThrow(RangeError);
  });
});
