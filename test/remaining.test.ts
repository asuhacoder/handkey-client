import { expect, test } from 'vitest';
import { remaining } from '../src/index.js';
import { toInstant } from '../src/parse.js';

test('remaining accepts a numeric epoch clock and returns bounded whole seconds', () => {
 const deadline = toInstant(10_000);
 expect([remaining(deadline, 8_999), remaining(deadline, 9_000), remaining(deadline, 10_000), remaining(deadline, 11_000)]).toEqual([2, 1, 0, 0]);
});
test.each([NaN, Infinity, -Infinity])('remaining rejects non-finite clock %s with zero', now => {
 expect(remaining(toInstant(10_000), now)).toBe(0);
});
