import { expect, test } from 'vitest';
import { createHandkey } from '../src/index.js';
import { created, fakeEnvironment, json, key, request, savedPersistence, URL_BASE, wireRequest, deferred, flush } from './helpers.js';

test('stopped approval survives rejected registration and re-registration until dismissed',async()=>{
 const fake=fakeEnvironment();const actor=createHandkey({environment:fake.environment,persistence:savedPersistence()});
 const one=request('one').id,two=request('two').id,three=request('three').id;
 fake.queue(json([wireRequest('one'),wireRequest('two'),wireRequest('three')]));await actor.refresh();
 fake.queue(json({status:'processed'}),json(wireRequest('one','approved','ready')),json({},401),json({},401));
 const report=await actor.approve([one,two,three],key());
 expect(report).toMatchObject({kind:'finished',stopped:'session-ended',items:[
  {id:'one',outcome:{kind:'executed'}},{id:'two',outcome:{kind:'session-ended'}},{id:'three',outcome:{kind:'not-sent',because:'batch-stopped'}},
 ]});
 expect(actor.getSnapshot()).toMatchObject({kind:'register',reason:'rejected',approval:{kind:'finished',stopped:'session-ended',items:[
  {id:'one',step:{kind:'done',outcome:{kind:'executed'}}},{id:'two',step:{kind:'done',outcome:{kind:'session-ended'}}},{id:'three',step:{kind:'done',outcome:{kind:'not-sent'}}},
 ]}});
 const retained=actor.getSnapshot().approval;
 fake.queue(json(created('replacement'),201));
 expect(await actor.register({brokerUrl:URL_BASE,deviceId:'device',name:'New',key:key()})).toEqual({kind:'registered',persistence:'saved'});
 expect(actor.getSnapshot()).toMatchObject({kind:'active',approval:retained});
 actor.dismissApproval();expect(actor.getSnapshot()).toMatchObject({kind:'active',approval:null});
});
test('dismiss clears register-state approval and signOut clears retained progress',async()=>{
 const fake=fakeEnvironment();const actor=createHandkey({environment:fake.environment,persistence:savedPersistence()});
 fake.queue(json([wireRequest('one')]));await actor.refresh();
 fake.queue(json({},401),json({},401));await actor.approve([request('one').id],key());
 actor.dismissApproval();expect(actor.getSnapshot()).toMatchObject({kind:'register',approval:null});
 fake.queue(json(created(),201));await actor.register({brokerUrl:URL_BASE,deviceId:'device',name:'New',key:key()});
 fake.queue(json([wireRequest('one')]));await actor.refresh();
 fake.queue(json({status:'processed'}),json(wireRequest('one','approved','ready')),json([]));await actor.approve([request('one').id],key());
 fake.queue(json({status:'revoked'}));await actor.signOut();
 expect(actor.getSnapshot()).toMatchObject({kind:'register',reason:'signed-out',approval:null});
});
test('a running approval stays undismissable and retains its settlement after signOut',async()=>{
 const fake=fakeEnvironment();const actor=createHandkey({environment:fake.environment,persistence:savedPersistence()});
 fake.queue(json([wireRequest('one'),wireRequest('two')]));await actor.refresh();
 const held=deferred<Response>();fake.queue(()=>held.promise);
 const operation=actor.approve([request('one').id,request('two').id],key());
 actor.dismissApproval();expect(actor.getSnapshot()).toMatchObject({kind:'active',approval:{kind:'running'}});
 fake.queue(json({status:'revoked'}));await actor.signOut();
 fake.queue(json({},401));held.resolve(json({status:'processed'}));await operation;await flush();
 expect(actor.getSnapshot()).toMatchObject({kind:'register',reason:'signed-out',approval:{kind:'finished',stopped:'session-ended',items:[{id:'one',step:{kind:'done',outcome:{kind:'outcome-unknown'}}},{id:'two',step:{kind:'done',outcome:{kind:'not-sent'}}}]}});
});
