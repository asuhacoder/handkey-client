import { consumeDeviceKey, createHandkey, memoryPersistence } from '../src/index.js';

const client = createHandkey({ persistence: memoryPersistence() });
export async function registerDevice(deviceKeyText: string) {
 const key = consumeDeviceKey(deviceKeyText);
 if (key === null) return { kind: 'invalid-key' };
 return client.register({ brokerUrl: 'http://127.0.0.1:8080', deviceId: 'device-id', name: 'Glasses', key });
}
export async function readPending() {
 await client.refresh();
 const snapshot = client.getSnapshot();
 return snapshot.kind === 'active' ? snapshot.pending : [];
}
