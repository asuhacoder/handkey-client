import {expect,test} from 'vitest';
import {createHandkey} from '../src/index.js';
import {count,fakeEnvironment,flush,json,savedPersistence,sse} from './helpers.js';

test('stream opening is live without sync and cancels down polling for two minutes',async()=>{
 const fake=fakeEnvironment();const actor=createHandkey({environment:fake.environment,persistence:savedPersistence()});
 const first=sse();fake.queue(first.response);const off=actor.subscribe(()=>{});await flush();first.close();await flush();
 const reopened=sse();fake.queue(json([]),reopened.response);await fake.advance(1000);
 expect(actor.getSnapshot()).toMatchObject({kind:'active',connection:'live'});
 fake.queue(json([]));reopened.push('event: change\ndata: {}\n\n');await flush();
 const lists=count(fake.calls,'/v1/requests');expect(lists).toBe(2);
 for(let window=0;window<2;window++) {
  for(let tick=0;tick<4;tick++){reopened.push(': heartbeat\n\n');await flush();await fake.advance(15_000);}
  expect(actor.getSnapshot()).toMatchObject({kind:'active',connection:'live'});
  expect(count(fake.calls,'/v1/requests')).toBe(lists);
 }
 off();expect(fake.timers.size).toBe(0);
});
