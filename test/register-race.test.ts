import { expect, test } from 'vitest';
import { createHandkey } from '../src/index.js';
import { created, deferred, fakeEnvironment, json, key, savedPersistence, URL_BASE } from './helpers.js';

test.each(['old-rejected','newer-record'])('registration completes according to persisted ownership after %s',async mode=>{
 const fake=fakeEnvironment(),persistence=savedPersistence();const actor=createHandkey({environment:fake.environment,persistence});
 const held=deferred<Response>();fake.queue(()=>held.promise);
 const registering=actor.register({brokerUrl:URL_BASE,deviceId:'device',name:'New',key:key()});
 if(mode==='old-rejected'){fake.queue(json({},401));await actor.refresh();expect(actor.getSnapshot()).toMatchObject({kind:'register',reason:'rejected'});}
 else {persistence.compareAndSwap(persistence.read(),JSON.stringify({version:1,brokerUrl:URL_BASE,deviceId:'device',sessionId:'other',viewToken:'other-token',viewUntil:fake.environment.now()+86400000}));fake.queue(json({status:'revoked'}));}
 held.resolve(json(created('replacement','replacement-token'),201));
 expect(await registering).toEqual({kind:'registered',persistence:mode==='old-rejected'?'saved':'superseded'});
 expect(persistence.read()).toContain(mode==='old-rejected'?'replacement-token':'other-token');
 expect(actor.getSnapshot()).toMatchObject({kind:'active',session:{sessionId:mode==='old-rejected'?'replacement':'other'}});
 const revokes=fake.calls.filter(call=>call.url.endsWith('/revoke')).map(call=>new URL(call.url).pathname);
 expect(revokes).toEqual(mode==='old-rejected'?[]:['/v1/sessions/replacement/revoke']);
});
