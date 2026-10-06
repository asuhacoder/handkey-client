import { createHandkey } from '../src/index.js';
import type { RequestId } from '../src/index.js';
import { browserEnvironment, takeKey, takeRegistration } from '../src/dom.js';
import type { CredentialForm, RegistrationForm } from '../src/dom.js';

declare function useSyncExternalStore<T>(subscribe: (listener: () => void) => () => void, getSnapshot: () => T, getServerSnapshot?: () => T): T;
const client = createHandkey(browserEnvironment({ storageKey: 'handkey.session' }));
export function useHandkey() {
 return useSyncExternalStore(client.subscribe, client.getSnapshot, client.getSnapshot);
}
export async function register(form: RegistrationForm) {
 const input = takeRegistration(form);
 if (input.kind !== 'ok') return input;
 return client.register(input.value);
}
export async function approve(form: CredentialForm, ids: readonly RequestId[]) {
 const input = takeKey(form);
 if (input.kind !== 'ok') return input;
 return client.approve(ids, input.key);
}
