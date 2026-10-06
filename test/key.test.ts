import { expect, test } from 'vitest';
import { inspect } from 'node:util';
import { consumeDeviceKey } from '../src/index.js';
import { claimKey, keyBody } from '../src/key.js';
const text = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
test('canonical keys expose only a fixed label and spend synchronously', () => {
 const key = consumeDeviceKey(text);
 if (key === null) throw new Error('fixture rejected');
 expect([String(key), JSON.stringify(key), `${key}`, Object.keys(key), inspect(key), Object.isFrozen(key)]).toEqual([
  '[DeviceKey]', '"[DeviceKey]"', '[DeviceKey]', [], '[DeviceKey]', true,
 ]);
 const bytes = claimKey(key);
 if (bytes === null) throw new Error('fixture spent');
 expect({ length: bytes.length, body: keyBody({bytes}), second: claimKey(key) }).toEqual({length:32,body:'{"key":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"}',second:null});
 bytes.fill(0);
});
test.each(['', 'A'.repeat(42), 'A'.repeat(44), 'A'.repeat(42)+'=', 'A'.repeat(42)+'+', 'A'.repeat(42)+'B'])('rejects malformed key %s', value => {
 expect(consumeDeviceKey(value)).toBeNull();
});
