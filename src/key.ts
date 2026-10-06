declare const deviceKeyBrand: unique symbol;
/** A single-use opaque handle. Serialization and inspection never expose its bytes. */
export interface DeviceKey { readonly [deviceKeyBrand]: true }
const bytesByKey = new WeakMap<DeviceKey, Uint8Array>();
const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
const prototype = Object.freeze({
 toString: () => '[DeviceKey]',
 toJSON: () => '[DeviceKey]',
 [Symbol.toPrimitive]: () => '[DeviceKey]',
 [Symbol.for('nodejs.util.inspect.custom')]: () => '[DeviceKey]',
});

/** Returns null unless text is exactly 32 bytes of canonical unpadded base64url. */
export function consumeDeviceKey(text: string): DeviceKey | null {
 if (!/^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/.test(text)) return null;
 const bytes = new Uint8Array(32);
 let buffer = 0;
 let bits = 0;
 let offset = 0;
 for (const char of text) {
  buffer = (buffer << 6) | alphabet.indexOf(char);
  bits += 6;
  if (bits >= 8) {
   bits -= 8;
   bytes[offset++] = (buffer >> bits) & 255;
  }
 }
 const handle = Object.freeze(Object.create(prototype)) as DeviceKey;
 bytesByKey.set(handle, bytes);
 return handle;
}

/** Internal synchronous ownership transfer. Guards must run after this call. */
export function claimKey(key: DeviceKey): Uint8Array | null {
 const bytes = bytesByKey.get(key);
 bytesByKey.delete(key);
 return bytes ?? null;
}

/** The only place raw key bytes become a string. */
export function keyBody(input: { bytes: Uint8Array; name?: string }): string {
 let encoded = '';
 let buffer = 0;
 let bits = 0;
 for (const byte of input.bytes) {
  buffer = (buffer << 8) | byte;
  bits += 8;
  while (bits >= 6) {
   bits -= 6;
   encoded += alphabet[(buffer >> bits) & 63];
  }
 }
 if (bits > 0) encoded += alphabet[(buffer << (6 - bits)) & 63];
 return input.name === undefined ? JSON.stringify({ key: encoded }) : JSON.stringify({ key: encoded, name: input.name });
}
