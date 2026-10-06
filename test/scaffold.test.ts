import { expect, test } from 'vitest';
import { BROKER_API } from '../src/index.js';

test('root loads without browser globals', () => {
 expect({ version: BROKER_API, browser: typeof window }).toEqual({ version: 'v1', browser: 'undefined' });
});
