import {expect,test} from 'vitest';
import {createHandkey} from '../src/index.js';
import {deferred,fakeEnvironment,json,key,request,savedPersistence,wireRequest} from './helpers.js';

test('deny cannot overlap the key-bearing approval of the same request',async()=>{
 const fake=fakeEnvironment();const actor=createHandkey({environment:fake.environment,persistence:savedPersistence()});
 fake.queue(json([wireRequest('one')]));await actor.refresh();
 const held=deferred<Response>();fake.queue(()=>held.promise);const approving=actor.approve([request('one').id],key());
 const before=fake.calls.length;
 const denied=await actor.deny([request('one').id]);
 expect(denied).toEqual({kind:'busy'});expect(fake.calls.slice(before)).toEqual([]);
 fake.queue(json(wireRequest('one','approved','ready')),json([]));held.resolve(json({status:'processed'}));
 expect(await approving).toMatchObject({kind:'finished',items:[{outcome:{kind:'executed'}}]});
});
