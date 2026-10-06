import { expect, test } from 'vitest';
import { createHandkey } from '../src/index.js';
import { deferred, fakeEnvironment, flush, json, key, request, savedPersistence, wireRequest } from './helpers.js';

test('sign-out stops key sends but confirms its in-flight approval and retains the report',async()=>{
 const fake=fakeEnvironment();const actor=createHandkey({environment:fake.environment,persistence:savedPersistence()});
 fake.queue(json([wireRequest('one'),wireRequest('two')]));await actor.refresh();
 const post=deferred<Response>(),revoke=deferred<Response>();
 fake.queue(()=>post.promise);const approving=actor.approve([request('one').id,request('two').id],key());
 fake.queue(()=>revoke.promise);const signingOut=actor.signOut();
 fake.queue(json(wireRequest('one','approved','ready')));
 post.resolve(json({status:'processed'}));await flush();
 const report=await approving;
 expect(report).toMatchObject({kind:'finished',stopped:'session-ended',items:[{id:'one',outcome:{kind:'executed'}},{id:'two',outcome:{kind:'not-sent',because:'batch-stopped'}}]});
 revoke.resolve(json({status:'revoked'}));await signingOut;
 expect(fake.calls.map(call=>[call.method,new URL(call.url).pathname])).toEqual([
  ['GET','/v1/requests'],['POST','/v1/requests/one/approve'],['POST','/v1/sessions/session/revoke'],['GET','/v1/requests/one'],
 ]);
 expect(actor.getSnapshot()).toMatchObject({kind:'register',reason:'signed-out',approval:{kind:'finished',stopped:'session-ended',items:[{id:'one',step:{kind:'done',outcome:{kind:'executed'}}},{id:'two',step:{kind:'done',outcome:{kind:'not-sent'}}}]}});
 actor.dismissApproval();expect(actor.getSnapshot()).toMatchObject({kind:'register',approval:null});
});
test('sign-out invoked by a progress listener before the POST sends no key',async()=>{
 const fake=fakeEnvironment();const actor=createHandkey({environment:fake.environment,persistence:savedPersistence()});
 fake.queue(json([wireRequest('one')]));await actor.refresh();
 let signingOut:Promise<void>|null=null;
 // Subscribing opens a stream; the listener starts sign-out before the approving step can POST.
 fake.queue(new Response(new ReadableStream(),{headers:{'Content-Type':'text/event-stream'}}));
 const off=actor.subscribe(()=>{if(actor.getSnapshot().approval?.items[0]?.step.kind==='approving' && signingOut===null){fake.queue(json({status:'revoked'}));signingOut=actor.signOut();}});
 const report=await actor.approve([request('one').id],key());await signingOut;
 expect(report).toMatchObject({kind:'finished',stopped:'session-ended',items:[{outcome:{kind:'not-sent',because:'batch-stopped'}}]});
 expect(fake.calls.filter(call=>call.url.endsWith('/approve'))).toEqual([]);
 expect(actor.getSnapshot()).toMatchObject({kind:'register',approval:{kind:'finished',stopped:'session-ended'}});off();
});
