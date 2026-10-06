import {expect,test} from 'vitest';
import {createHandkey} from '../src/index.js';
import {memoryPersistence} from '../src/environment.js';
import {deferred,fakeEnvironment,flush,json,key,NOW,request,sse,URL_BASE,wireRequest} from './helpers.js';

test('expiry during confirming GET keeps a real execution and stops only remaining items',async()=>{
 const fake=fakeEnvironment(),persistence=memoryPersistence();
 persistence.compareAndSwap(null,JSON.stringify({version:1,brokerUrl:URL_BASE,deviceId:'device',sessionId:'session',viewToken:'token',viewUntil:NOW+1000}));
 const actor=createHandkey({environment:fake.environment,persistence});
 fake.queue(sse().response,json([wireRequest('one'),wireRequest('two')]));const off=actor.subscribe(()=>{});await actor.refresh();
 const checked=deferred<Response>();fake.queue(json({status:'processed'}),()=>checked.promise);
 const approving=actor.approve([request('one').id,request('two').id],key());await flush();
 await fake.advance(1000);expect(actor.getSnapshot()).toMatchObject({kind:'register',reason:'expired'});
 checked.resolve(json(wireRequest('one','approved','ready')));
 const report=await approving;
 expect(report).toMatchObject({kind:'finished',stopped:'session-ended',items:[{id:'one',outcome:{kind:'executed'}},{id:'two',outcome:{kind:'not-sent'}}]});
 expect(actor.getSnapshot()).toMatchObject({kind:'register',approval:{kind:'finished',stopped:'session-ended',items:[{id:'one',step:{kind:'done',outcome:{kind:'executed'}}},{id:'two',step:{kind:'done',outcome:{kind:'not-sent'}}}]}});
 expect(fake.calls.map(call=>new URL(call.url).pathname)).toEqual(['/v1/events','/v1/requests','/v1/requests/one/approve','/v1/requests/one']);off();
});
