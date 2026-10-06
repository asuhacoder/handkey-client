import { expect, test } from 'vitest';
import { createHandkey } from '../src/index.js';
import { count, fakeEnvironment, flush, json, savedPersistence, sse } from './helpers.js';

test('short sync-then-EOF connections retain growing reconnect backoff', async () => {
 const fake = fakeEnvironment();
 const actor = createHandkey({environment:fake.environment,persistence:savedPersistence()});
 const first = sse(); fake.queue(first.response,json([]));
 const off = actor.subscribe(()=>{}); await flush();
 first.push('event: sync\ndata: {}\n\n'); await flush(); first.close(); await flush();
 const second = sse(); fake.queue(json([]),second.response,json([]));
 await fake.advance(1000); second.push('event: sync\ndata: {}\n\n'); await flush(); second.close(); await flush();
 expect(count(fake.calls,'/v1/events')).toBe(2);
 await fake.advance(1000);
 expect(count(fake.calls,'/v1/events')).toBe(2);
 const third = sse(); fake.queue(json([]),third.response);
 await fake.advance(1000);
 expect(count(fake.calls,'/v1/events')).toBe(3);
 off(); await flush(); expect(fake.timers.size).toBe(0);
});
