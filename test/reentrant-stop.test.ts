import {expect,test} from 'vitest';
import {createHandkey} from '../src/index.js';
import {fakeEnvironment,flush,json,key,request,savedPersistence,sse,wireRequest} from './helpers.js';

test('a queued-run subscriber sign-out settles and emits before any approving POST',async()=>{
 const fake=fakeEnvironment();const actor=createHandkey({environment:fake.environment,persistence:savedPersistence()});
 fake.queue(json([wireRequest('one')]));await actor.refresh();
 fake.queue(sse().response);
 let signingOut:Promise<void>|null=null;
 const off=actor.subscribe(()=>{if(actor.getSnapshot().approval?.items[0]?.step.kind==='queued' && signingOut===null){fake.queue(json({status:'revoked'}));signingOut=actor.signOut();}});
 const report=await actor.approve([request('one').id],key());await signingOut;await flush();
 expect(report).toMatchObject({kind:'finished',stopped:'session-ended',items:[{outcome:{kind:'not-sent',because:'batch-stopped'}}]});
 expect(actor.getSnapshot()).toMatchObject({kind:'register',approval:{kind:'finished',stopped:'session-ended',items:[{step:{kind:'done',outcome:{kind:'not-sent'}}}]}});
 expect(fake.calls.map(call=>new URL(call.url).pathname)).toEqual(['/v1/requests','/v1/events','/v1/sessions/session/revoke']);off();
});
