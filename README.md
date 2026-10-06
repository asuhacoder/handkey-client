# handkey-client

A TypeScript approval client for the handkey broker. It targets the `v1` HTTP routes. The broker reports no API version, so `BROKER_API` is a statement of intent, not a negotiated value. The library has no runtime dependencies and requires Node.js 22 or a browser with fetch and readable streams.

The root entry does not require DOM types. `handkey-client/dom` provides password-input helpers and browser persistence. The library has no React dependency.

## Install

```sh
pnpm add handkey-client
```

## React consumer

Create one actor outside the component. `subscribe` starts its SSE feed. The last unsubscribe aborts the feed and clears timers. `getSnapshot` has stable identity between changes and never contains the view token or device key.

```ts
import { useSyncExternalStore } from 'react';
import { createHandkey, remaining } from 'handkey-client';
import type { RequestId } from 'handkey-client';
import { browserEnvironment, takeKey, takeRegistration } from 'handkey-client/dom';
import type { CredentialForm, RegistrationForm } from 'handkey-client/dom';

const client = createHandkey(browserEnvironment({ storageKey: 'handkey.session' }));
export function useHandkey() {
 return useSyncExternalStore(client.subscribe, client.getSnapshot, client.getSnapshot);
}
export function approvalProgress() {
 return client.getSnapshot().approval;
}
export function dismissApproval() {
 client.dismissApproval();
}
export function pendingSeconds(now = Date.now()) {
 const snapshot = client.getSnapshot();
 return snapshot.kind === 'active' ? snapshot.pending.map(request => remaining(request.deadline, now)) : [];
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
```

`CredentialForm` has `deviceId` and `key` inputs with writable `value` fields. `RegistrationForm` also has `brokerUrl` and `name` inputs. Pass input refs, not input values. `CREDENTIAL_ATTRIBUTES.deviceId` sets `autocomplete="username"`, `name="username"`, and `type="text"`. `CREDENTIAL_ATTRIBUTES.key` sets `autocomplete="current-password"`, `name="password"`, and `type="password"`.

Both helpers read the password once and empty its input before returning, including validation failures. Do not place the raw key in component state. Browser ports access window, document, and localStorage only when `browserEnvironment` is called. Create them on the client, not during server rendering.

The checked version of this example is in `usage-check/react.ts`. It supplies React's generic external-store hook signature without adding React to this package's development dependencies.

## Non-DOM consumer

```ts
import { consumeDeviceKey, createHandkey, memoryPersistence } from 'handkey-client';

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
```

The checked version is in `usage-check/node.ts`. `pnpm typecheck` compiles this file and the root with `lib: ["ES2022"]`, without the DOM library. Node's platform declarations supply fetch and stream types.

Memory persistence is isolated per instance. A custom `Persistence` stores an opaque versioned string through `read`, `compareAndSwap`, and optional `subscribe`. The saved record contains only the broker URL, device ID, session ID, view token, view expiry, and schema version. HTTP and HTTPS origins are accepted. Credentials, paths other than `/`, query strings, and fragments are rejected. Use HTTPS outside development.

## Requests and snapshots

The snapshot is either `register` or `active`. Both variants have `approval: ApprovalRun | null`. The registration snapshot has a closed reason and optional remembered broker URL and device ID. The active snapshot also has the session identity, pending requests, unreadable entry count, list freshness, and connection status.

`remaining(deadline, now)` accepts epoch milliseconds for `now`, including `Date.now()`. It returns whole nonnegative seconds and returns zero for a non-finite clock.

Pending requests sort by deadline, then request ID. A successful broker list shows every readable pending entry. A subscribed actor prunes locally only when the deadline was later than the client clock at fetch time. An already-passed deadline may reflect clock skew, so the entry stays until a later list removes it. Malformed list entries increase `unreadable` without dropping the list.

Operations, approval states, and execution states are discriminated unions. Unknown enum values become `unrecognized`. Broker execution `unknown` becomes `outcome-unknown`. Secret names require narrowing `verified`, `unverified`, or `legacy`; bindings refer to the joined secret reference. Cautions identify disclosure, unmasked output, persistent clipboard contents, unreviewable write values, unverified names, long leases, and multiple uses. Create-field values never enter the domain model.

Agent names, reasons, command entries, directories, item names, and session names are untrusted text. Render them as plain text. The library supplies no user-facing wording or translations.

## Approval outcomes

A batch sends approvals sequentially. It never retries a POST automatically. The approval timeout is 150 seconds. Each item moves through `queued`, `approving`, `confirming`, and `done`; a 404 skips confirmation. Progress stays in `snapshot.approval` through session loss and re-registration until `dismissApproval()`. Dismissal works in both snapshot variants and does nothing while a run is running. A new approval batch replaces a finished run. `signOut()` clears it.

| Approve response | Confirmation | Item outcome | Batch |
| --- | --- | --- | --- |
| 200 | GET request | Approved with ready, succeeded, or consumed execution: `executed`. Failed: `execution-failed`. Other state or failed GET: `outcome-unknown`. | Continue |
| 409 | Best-effort GET | `already-decided` | Continue |
| 401 | View-token GET | GET 401: `session-ended`. GET 200 or 404: `key-rejected`. Other GET failure: `auth-undetermined`. | Stop |
| 404 | None | `not-found` | Stop |
| Other status, network failure, or timeout | GET request | Approved: use the 200 outcomes. Decided otherwise: `already-decided`. Pending or failed GET: `interrupted`. | Stop |

Later items are `not-sent` after a stop. Duplicate IDs send once. Unrecognized methods are `not-sent` with `because: 'not-reviewable'`. `executed` appears only after a confirming GET, never from a successful POST alone.

Finished approval and deny batches immediately remove requests known to be decided from `pending`, then trigger the same coalesced re-list as `refresh()`. Interrupted, key-rejected, authentication-undetermined, and not-sent requests stay pending unless the new list says otherwise. Reports resolve without waiting for the re-list. Session-ended batches do not re-list.

Deny uses only the view token and sends no body. It continues on 200 and 409, and stops on 401, 404, or other failure. A 401 on list, read, deny, events, or a confirming read clears the session and returns to registration. A 401 on the approve request itself does not clear it. The confirming read decides between a rejected key and an ended session. Key-only session list and revoke work without a registered view session. `revokeSibling` disambiguates a key-bearing 401 with a view-only session read.

## Key handling

`consumeDeviceKey` accepts exactly 32 bytes encoded as 43 canonical unpadded base64url characters. It returns an opaque frozen object. String conversion, JSON serialization, and inspection show `[DeviceKey]`; own keys contain no credential. Secret bytes stay in a module-private WeakMap.

Every key-taking method claims the key synchronously before checking guards. The key is spent even when a call is busy, not registered, has no IDs, or fails on the network. Reuse returns `key-spent` without making a fetch call. Claimed bytes are zeroed in `finally`. Raw keys are encoded only at the JSON body boundary. They never enter snapshots, results, thrown messages, faults, or persistence.

JavaScript cannot guarantee erasure of the temporary input string or fetch buffers. The library is not a sandbox. The consumer controls its inputs, custom fetch implementation, and persistence. A consumer that logs fetch bodies can expose the key. The view token never appears in a snapshot or a result. It exists in the persisted record, in memory, and in Authorization headers inside the library.

## Faults and connection behavior

Expected failures resolve as closed result unions. `Fault.kind` is `network`, `timeout`, `unavailable`, `protocol`, or `storage`. Faults contain no response text or exception cause. Error bodies are not read. Fetch uses `redirect: 'error'`, `cache: 'no-store'`, and `credentials: 'omit'`.

A `network` fault can mean a disconnected host, DNS failure, TLS failure, browser CORS denial, or a missing broker `--origins` entry for the page's origin. A browser cannot reliably distinguish these causes. The library does not run a no-cors probe.

The feed re-lists after sync, change hints, reconnect, visibility regained, and explicit refresh. Concurrent hints coalesce into one active list with one trailing list. A 25-second heartbeat watchdog reconnects silent streams. Full-jitter exponential backoff starts at one second and caps at 30 seconds. While down, the actor polls every 60 seconds.

## Known limits

Each subscribed actor uses one SSE stream. Tabs do not share streams or batch progress. HTTP/1.1 browsers usually allow six concurrent connections per origin, so several tabs can exhaust that limit.

Persistence compare-and-swap is atomic with respect to callers in the same JavaScript realm and best effort across tabs. A cross-process localStorage race can clear or overwrite a newer registration, requiring the user to register again. The view token cannot approve. It can list and read requests, deny them, read events, list the device's sessions, and end its own session.

## Development

```sh
pnpm install
pnpm verify
```

`verify` typechecks examples and the non-DOM root, runs Node tests, and builds JavaScript and declarations into `lib/`. `pnpm test:integration` skips unless `HANDKEY_BIN` names an absolute path to a handkey executable. With that variable set, it starts a development broker with a stub 1Password command, submits requests through the actual CLI Unix socket, and exercises real SSE, approval, denial, and key-based session administration. Scratch files stay under the ignored `.it/` directory.
