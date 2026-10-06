import { defaultEnvironment } from './environment.js';
import type { Environment, Persistence } from './environment.js';
import { consumeDeviceKey } from './key.js';
import type { DeviceKey } from './key.js';
import { normalizeBrokerUrl } from './parse.js';

/** Apply these attributes to the device ID and device key inputs for password-manager autofill. */
export const CREDENTIAL_ATTRIBUTES = Object.freeze({
  deviceId: Object.freeze({ autocomplete: 'username', name: 'username', type: 'text' }),
  key: Object.freeze({ autocomplete: 'current-password', name: 'password', type: 'password' }),
});

/** Structural inputs also work with framework refs and small non-browser test doubles. */
export interface CredentialForm {
  readonly deviceId: { value: string };
  readonly key: { value: string };
}
export interface RegistrationForm extends CredentialForm {
  readonly brokerUrl: { value: string };
  readonly name: { value: string };
}
export type TakeKeyResult = { readonly kind: 'ok'; readonly key: DeviceKey }
  | { readonly kind: 'empty-key' } | { readonly kind: 'invalid-key' };
export type TakeRegistrationResult = {
  readonly kind: 'ok';
  readonly value: { readonly brokerUrl: string; readonly deviceId: string; readonly name: string; readonly key: DeviceKey };
} | { readonly kind: 'empty-key' } | { readonly kind: 'invalid-key' }
  | { readonly kind: 'invalid-broker-url' } | { readonly kind: 'invalid-device-id' } | { readonly kind: 'invalid-name' };

/** Reads the password once and clears it before validation. No result carries its raw text. */
export function takeKey(form: CredentialForm): TakeKeyResult {
  const text = form.key.value;
  form.key.value = '';
  if (text.length === 0) return { kind: 'empty-key' };
  const key = consumeDeviceKey(text);
  return key === null ? { kind: 'invalid-key' } : { kind: 'ok', key };
}

/** Clears the password before reading other fields, including on every validation failure. */
export function takeRegistration(form: RegistrationForm): TakeRegistrationResult {
  const text = form.key.value;
  form.key.value = '';
  const brokerUrl = normalizeBrokerUrl(form.brokerUrl.value);
  if (brokerUrl === null) return { kind: 'invalid-broker-url' };
  const deviceId = form.deviceId.value;
  if (deviceId.length === 0) return { kind: 'invalid-device-id' };
  const name = form.name.value;
  if ([...name].length > 128 || /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(name)) return { kind: 'invalid-name' };
  if (text.length === 0) return { kind: 'empty-key' };
  const key = consumeDeviceKey(text);
  if (key === null) return { kind: 'invalid-key' };
  return { kind: 'ok', value: { brokerUrl, deviceId, name, key } };
}

/**
 * Creates browser ports on demand. Importing this module never reads DOM globals.
 * Records remain opaque. Storage errors reach the actor's storage fault handling.
 * CAS is atomic for callers in the same JS realm and best effort across tabs.
 */
export function browserEnvironment(options: { storageKey: string }): { persistence: Persistence; environment: Environment } {
  const browser = window;
  const page = document;
  const storageKey = options.storageKey;
  const listeners = new Set<() => void>();
  const notify = (): void => {
    for (const listener of listeners) {
      try { listener(); } catch { /* A subscriber cannot undo a committed write. */ }
    }
  };
  const onStorage = (event: StorageEvent): void => {
    if (event.storageArea === browser.localStorage && (event.key === storageKey || event.key === null)) notify();
  };
  const persistence: Persistence = {
    read: () => browser.localStorage.getItem(storageKey),
    compareAndSwap(expected, next) {
      const storage = browser.localStorage;
      if (storage.getItem(storageKey) !== expected) return false;
      if (next === expected) return true;
      if (next === null) storage.removeItem(storageKey);
      else storage.setItem(storageKey, next);
      notify();
      return true;
    },
    subscribe(callback) {
      if (listeners.size === 0) browser.addEventListener('storage', onStorage);
      listeners.add(callback);
      return () => {
        listeners.delete(callback);
        if (listeners.size === 0) browser.removeEventListener('storage', onStorage);
      };
    },
  };
  const environment: Environment = {
    ...defaultEnvironment(),
    visibility: {
      isVisible: () => page.visibilityState === 'visible',
      subscribe(callback) {
        page.addEventListener('visibilitychange', callback);
        return () => { page.removeEventListener('visibilitychange', callback); };
      },
    },
  };
  return { persistence, environment };
}
