import type {DeviceKey,Snapshot} from '../src/index.js';
// @ts-expect-error DeviceKey is constructible only through consumeDeviceKey.
const fabricated:DeviceKey={};
declare const snapshot:Snapshot;
// @ts-expect-error Snapshots never expose a token.
snapshot.token;
// @ts-expect-error Snapshots never expose the broker view token.
snapshot.viewToken;
export {fabricated};
