import { expect, test } from 'vitest';
import { createHandkey } from '../src/index.js';
import { fakeEnvironment, json, key, request, savedPersistence, wireRequest } from './helpers.js';

test.each(['never-listed','unreadable','inspected'])('%s ids cannot be approved without a parsed pending entry',async mode=>{
 const fake=fakeEnvironment();const actor=createHandkey({environment:fake.environment,persistence:savedPersistence()});
 const id=request('one').id;
 if(mode==='unreadable') {fake.queue(json([{id:'one',spec:{method:'otp'},deadline:'bad'}]));await actor.refresh();expect(actor.getSnapshot()).toMatchObject({kind:'active',unreadable:1,pending:[]});}
 if(mode==='inspected') {fake.queue(json(wireRequest('one','pending','not_started',undefined,'future')));expect(await actor.inspect(id)).toMatchObject({kind:'ok',value:{operation:{kind:'unrecognized'}}});}
 const before=fake.calls.length;
 const report=await actor.approve([id],key());
 expect(report).toEqual({kind:'finished',stopped:null,items:[{id:'one',request:null,outcome:{kind:'not-sent',because:'not-reviewable'}}]});
 expect(fake.calls.slice(before)).toEqual([]);
});
