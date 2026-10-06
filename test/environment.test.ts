import { afterEach, expect, test, vi } from 'vitest';
import { defaultEnvironment } from '../src/environment.js';

afterEach(() => { vi.useRealTimers(); });
test('long platform timers fire at their deadline rather than overflowing', () => {
 vi.useFakeTimers(); vi.setSystemTime(0);
 const environment = defaultEnvironment();
 let calls = 0;
 const handle = environment.setTimeout(() => { ++calls; }, 90 * 24 * 60 * 60 * 1000);
 vi.advanceTimersByTime(2_147_483_647);
 expect({calls,timers:vi.getTimerCount()}).toEqual({calls:0,timers:1});
 vi.advanceTimersByTime(90 * 24 * 60 * 60 * 1000 - 2_147_483_647);
 expect({calls,timers:vi.getTimerCount()}).toEqual({calls:1,timers:0});
 environment.clearTimeout(handle);
});
test('cancelling a rearmed long timer clears its next platform wakeup', () => {
 vi.useFakeTimers(); vi.setSystemTime(0);
 const environment = defaultEnvironment();
 let calls = 0;
 const handle = environment.setTimeout(() => { ++calls; }, 90 * 24 * 60 * 60 * 1000);
 vi.advanceTimersByTime(2_147_483_647);
 environment.clearTimeout(handle);
 vi.advanceTimersByTime(90 * 24 * 60 * 60 * 1000);
 expect({calls,timers:vi.getTimerCount()}).toEqual({calls:0,timers:0});
});
