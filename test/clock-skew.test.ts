import { expect, test } from 'vitest';
import { createHandkey } from '../src/index.js';
import { fakeEnvironment, flush, json, NOW, savedPersistence, sse, wireRequest } from './helpers.js';

test.each([-20,20])('a clock skew of %s minutes does not hide a broker-listed request',async minutes=>{
 const fake=fakeEnvironment();const offset=minutes*60_000;
 const actor=createHandkey({environment:{...fake.environment,now:()=>fake.environment.now()+offset},persistence:savedPersistence()});
 const feed=sse();fake.queue(feed.response,json([wireRequest('one','pending','not_started',NOW+15*60_000)]));
 const off=actor.subscribe(()=>{});await actor.refresh();
 expect(actor.getSnapshot()).toMatchObject({kind:'active',pending:[{id:'one'}],unreadable:0,list:{kind:'fresh'}});
 feed.push(': heartbeat\n\n');await flush();await fake.advance(10_000);
 expect(actor.getSnapshot()).toMatchObject({kind:'active',pending:[{id:'one'}]});
 off();expect(fake.timers.size).toBe(0);
});
test('an aligned clock prunes a listed request at its observed positive deadline',async()=>{
 const fake=fakeEnvironment();const actor=createHandkey({environment:fake.environment,persistence:savedPersistence()});
 fake.queue(sse().response,json([wireRequest('one','pending','not_started',NOW+1000)]));
 const off=actor.subscribe(()=>{});await actor.refresh();
 expect(actor.getSnapshot()).toMatchObject({kind:'active',pending:[{id:'one'}]});
 await fake.advance(1000);expect(actor.getSnapshot()).toMatchObject({kind:'active',pending:[]});off();
});
