import { afterEach, describe, expect, it, vi } from 'vitest';
import { browserEnvironment, takeKey, takeRegistration } from '../src/dom.js';
import { claimKey } from '../src/key.js';

const keyText = 'A'.repeat(43);
function password(value: string) {
  let stored = value;
  let reads = 0;
  const writes: string[] = [];
  return {
    input: { get value() { reads++; return stored; }, set value(next: string) { stored = next; writes.push(next); } },
    state: () => ({ stored, reads, writes }),
  };
}
function registration(input: { brokerUrl?: string; deviceId?: string; name?: string; key?: string } = {}) {
  const secret = password(input.key ?? keyText);
  return {
    secret,
    form: {
      key: secret.input,
      brokerUrl: { get value() { expect(secret.state().stored).toBe(''); return input.brokerUrl ?? 'https://broker.example/'; } },
      deviceId: { value: input.deviceId ?? 'legacy-device-id' },
      name: { value: input.name ?? 'Browser' },
    },
  };
}

afterEach(() => { vi.unstubAllGlobals(); });

describe('credential consumption', () => {
  it('reads and clears a two-input credential form once and returns a single-use opaque key', () => {
    const secret = password(keyText);
    const result = takeKey({ deviceId: { value: 'device' }, key: secret.input });
    expect(result.kind).toBe('ok');
    expect(secret.state()).toEqual({ stored: '', reads: 1, writes: [''] });
    expect(JSON.stringify(result)).toBe('{"kind":"ok","key":"[DeviceKey]"}');
    if (result.kind !== 'ok') throw new Error('Expected key');
    expect(claimKey(result.key)).toEqual(new Uint8Array(32));
    expect(claimKey(result.key)).toBeNull();
  });

  it.each([
    { text: '', kind: 'empty-key' },
    { text: 'secret-not-a-key', kind: 'invalid-key' },
    { text: 'A'.repeat(42) + 'B', kind: 'invalid-key' },
    { text: ' ' + keyText, kind: 'invalid-key' },
  ])('clears a $kind approval before returning its closed problem', ({ text, kind }) => {
    const secret = password(text);
    expect(takeKey({ deviceId: { value: '' }, key: secret.input })).toEqual({ kind });
    expect(secret.state()).toEqual({ stored: '', reads: 1, writes: [''] });
  });

  it('clears before other registration fields are read and preserves legacy IDs and Unicode names', () => {
    const { form, secret } = registration({ brokerUrl: 'https://BROKER.example:443/', name: '😀'.repeat(128) });
    const result = takeRegistration(form);
    expect(result.kind).toBe('ok');
    expect(secret.state()).toEqual({ stored: '', reads: 1, writes: [''] });
    if (result.kind !== 'ok') throw new Error('Expected registration');
    expect(result.value.brokerUrl).toBe('https://broker.example');
    expect(result.value.deviceId).toBe('legacy-device-id');
    expect(result.value.name).toBe('😀'.repeat(128));
    expect(JSON.stringify(result.value)).not.toContain(keyText);
    expect(claimKey(result.value.key)).toEqual(new Uint8Array(32));
  });

  it.each([
    { input: { brokerUrl: 'not a URL' }, kind: 'invalid-broker-url' },
    { input: { brokerUrl: 'https://user:password@broker.example' }, kind: 'invalid-broker-url' },
    { input: { brokerUrl: 'https://broker.example/path' }, kind: 'invalid-broker-url' },
    { input: { brokerUrl: 'https://broker.example/?q=1' }, kind: 'invalid-broker-url' },
    { input: { deviceId: '' }, kind: 'invalid-device-id' },
    { input: { name: 'a'.repeat(129) }, kind: 'invalid-name' },
    { input: { name: '\ud800' }, kind: 'invalid-name' },
    { input: { name: '\udc00' }, kind: 'invalid-name' },
    { input: { key: '' }, kind: 'empty-key' },
    { input: { key: 'bad secret' }, kind: 'invalid-key' },
  ])('clears every $kind registration failure without returning raw credentials', ({ input, kind }) => {
    const { form, secret } = registration(input);
    expect(takeRegistration(form)).toEqual({ kind });
    expect(secret.state()).toEqual({ stored: '', reads: 1, writes: [''] });
  });

  it('accepts an empty session name and does not retain the password on a field getter exception', () => {
    const valid = registration({ name: '' });
    const result = takeRegistration(valid.form);
    expect(result.kind).toBe('ok');
    if (result.kind !== 'ok') throw new Error('Expected registration');
    expect(result.value.name).toBe('');
    const secret = password(keyText);
    expect(() => takeRegistration({ key: secret.input, deviceId: { value: 'device' }, name: { value: '' },
      brokerUrl: { get value(): string { throw new Error('Broken input'); } },
    })).toThrow('Broken input');
    expect(secret.state()).toEqual({ stored: '', reads: 1, writes: [''] });
  });
});

function browserFake() {
  const records = new Map<string, string>();
  const storage = {
    getItem: (key: string) => records.get(key) ?? null,
    setItem: (key: string, value: string) => { records.set(key, value); },
    removeItem: (key: string) => { records.delete(key); },
  };
  const browser = Object.assign(new EventTarget(), { localStorage: storage });
  const page = Object.assign(new EventTarget(), { visibilityState: 'visible' });
  vi.stubGlobal('window', browser);
  vi.stubGlobal('document', page);
  const storageEvent = (key: string | null, area: unknown = storage) => {
    const event = new Event('storage');
    Object.defineProperties(event, { key: { value: key }, storageArea: { value: area } });
    browser.dispatchEvent(event);
  };
  return { storage, browser, page, storageEvent };
}

describe('browser ports without jsdom', () => {
  it('compares opaque records, refuses stale removal, and notifies committed changes', () => {
    const fake = browserFake();
    const { persistence } = browserEnvironment({ storageKey: 'handkey' });
    const observed: (string | null)[] = [];
    const unsubscribe = persistence.subscribe?.(() => { observed.push(persistence.read()); });
    expect(persistence.read()).toBeNull();
    expect(persistence.compareAndSwap(null, 'opaque-one')).toBe(true);
    fake.storage.setItem('handkey', 'opaque-newer');
    expect(persistence.compareAndSwap('opaque-one', null)).toBe(false);
    expect(persistence.read()).toBe('opaque-newer');
    expect(persistence.compareAndSwap('opaque-newer', 'opaque-newer')).toBe(true);
    expect(persistence.compareAndSwap('opaque-newer', null)).toBe(true);
    expect(observed).toEqual(['opaque-one', null]);
    unsubscribe?.();
    expect(persistence.compareAndSwap(null, 'after-unsubscribe')).toBe(true);
    expect(observed).toEqual(['opaque-one', null]);
  });

  it('adopts only matching localStorage events, including clear, and unsubscribes', () => {
    const fake = browserFake();
    const { persistence } = browserEnvironment({ storageKey: 'handkey' });
    const observed: (string | null)[] = [];
    const unsubscribe = persistence.subscribe?.(() => { observed.push(persistence.read()); });
    fake.storage.setItem('handkey', 'external-record');
    fake.storageEvent('other');
    fake.storageEvent('handkey', {});
    fake.storageEvent('handkey');
    fake.storage.removeItem('handkey');
    fake.storageEvent(null);
    expect(observed).toEqual(['external-record', null]);
    unsubscribe?.();
    fake.storage.setItem('handkey', 'ignored');
    fake.storageEvent('handkey');
    expect(observed).toEqual(['external-record', null]);
  });

  it('reports document visibility and removes visibility listeners', () => {
    const fake = browserFake();
    const { environment } = browserEnvironment({ storageKey: 'handkey' });
    const observed: boolean[] = [];
    expect(environment.visibility?.isVisible()).toBe(true);
    const unsubscribe = environment.visibility?.subscribe(() => { observed.push(environment.visibility?.isVisible() ?? false); });
    fake.page.visibilityState = 'hidden';
    fake.page.dispatchEvent(new Event('visibilitychange'));
    fake.page.visibilityState = 'visible';
    fake.page.dispatchEvent(new Event('visibilitychange'));
    expect(observed).toEqual([false, true]);
    unsubscribe?.();
    fake.page.visibilityState = 'hidden';
    fake.page.dispatchEvent(new Event('visibilitychange'));
    expect(observed).toEqual([false, true]);
  });

  it('propagates storage failures without replacing them with raw records', () => {
    const fake = browserFake();
    const { persistence } = browserEnvironment({ storageKey: 'handkey' });
    fake.storage.setItem = () => { throw new Error('Storage unavailable'); };
    expect(() => persistence.compareAndSwap(null, 'opaque-record')).toThrow('Storage unavailable');
    expect(persistence.read()).toBeNull();
  });
});

it('imports the DOM entry without window or document', async () => {
  vi.stubGlobal('window', undefined);
  vi.stubGlobal('document', undefined);
  vi.resetModules();
  const dom = await import('../src/dom.js');
  expect(dom.takeKey({ deviceId: { value: 'device' }, key: { value: '' } })).toEqual({ kind: 'empty-key' });
});
