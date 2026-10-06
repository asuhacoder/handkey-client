import { expect, test } from 'vitest';
import { createHandkey } from '../src/index.js';
import { count, deferred, fakeEnvironment, flush, json, key, request, savedPersistence, wireRequest } from './helpers.js';

function pending(actor: ReturnType<typeof createHandkey>) {
 const snapshot = actor.getSnapshot();
 return snapshot.kind === 'active' ? snapshot.pending.map(item => item.id) : null;
}
test.each(['deny', 'approve'])('%s removes decided ids before its coalesced re-list returns', async method => {
 const fake = fakeEnvironment();
 const actor = createHandkey({environment:fake.environment,persistence:savedPersistence()});
 const one=request('one').id, two=request('two').id;
 fake.queue(json([wireRequest('one'),wireRequest('two')])); await actor.refresh();
 const oldList=deferred<Response>(), freshList=deferred<Response>();
 fake.queue(()=>oldList.promise); const refreshing=actor.refresh();
 if(method==='deny') fake.queue(json({status:'denied'}));
 else fake.queue(json({status:'processed'}),json(wireRequest('one','approved','ready')));
 fake.queue(()=>freshList.promise);
 const report=method==='deny' ? await actor.deny([one]) : await actor.approve([one],key());
 expect(report.kind).toBe('finished');
 expect(pending(actor)).toEqual(['two']);
 expect(count(fake.calls,'/v1/requests')).toBe(2);
 oldList.resolve(json([wireRequest('one'),wireRequest('two')])); await flush();
 expect(pending(actor)).toEqual(['two']);
 expect(count(fake.calls,'/v1/requests')).toBe(3);
 freshList.resolve(json([wireRequest('two')])); await refreshing;
 expect(pending(actor)).toEqual(['two']);
 expect(fake.timers.size).toBe(0);
});
test.each([200,409,404,503])('deny %s updates pending and re-lists without SSE', async status=>{
 const fake=fakeEnvironment();const actor=createHandkey({environment:fake.environment,persistence:savedPersistence()});
 fake.queue(json([wireRequest('one'),wireRequest('two')]));await actor.refresh();
 const listed=deferred<Response>();
 fake.queue(json(status===200?{status:'denied'}:{},status),()=>listed.promise);
 const report=await actor.deny([request('one').id]);
 expect(report).toMatchObject({kind:'finished',items:[{id:'one',outcome:{kind:status===200?'denied':status===409?'already-decided':status===404?'not-found':'interrupted'}}]});
 expect(pending(actor)).toEqual(status===503?['one','two']:['two']);
 expect(count(fake.calls,'/v1/requests')).toBe(2);
 listed.resolve(json(status===503?[wireRequest('one'),wireRequest('two')]:[wireRequest('two')]));await flush();
});
test.each([
 {post:200,approval:'approved',execution:'failed',outcome:'execution-failed',removed:true},
 {post:200,approval:'approved',execution:'unknown',outcome:'outcome-unknown',removed:true},
 {post:200,approval:'pending',execution:'not_started',outcome:'outcome-unknown',removed:false},
 {post:409,approval:'denied',execution:'not_started',outcome:'already-decided',removed:true},
 {post:401,approval:'pending',execution:'not_started',outcome:'key-rejected',removed:false},
 {post:503,approval:'pending',execution:'not_started',outcome:'interrupted',removed:false},
 {post:404,approval:'pending',execution:'not_started',outcome:'not-found',removed:true},
])('approve $outcome preserves only uncertain pending requests',async row=>{
 const fake=fakeEnvironment();const actor=createHandkey({environment:fake.environment,persistence:savedPersistence()});
 fake.queue(json([wireRequest('one'),wireRequest('two')]));await actor.refresh();
 fake.queue(json(row.post===200?{status:'processed'}:{},row.post));
 if(row.post!==404)fake.queue(json(wireRequest('one',row.approval,row.execution)));
 const listed=deferred<Response>();fake.queue(()=>listed.promise);
 const report=await actor.approve([request('one').id],key());
 expect(report).toMatchObject({kind:'finished',items:[{id:'one',outcome:{kind:row.outcome}}]});
 expect(pending(actor)).toEqual(row.removed?['two']:['one','two']);
 expect(count(fake.calls,'/v1/requests')).toBe(2);
 listed.resolve(json([wireRequest('two')]));await flush();
});
test('session-ended deny does not try a re-list',async()=>{
 const fake=fakeEnvironment();const actor=createHandkey({environment:fake.environment,persistence:savedPersistence()});
 fake.queue(json({},401));expect(await actor.deny([request('one').id])).toMatchObject({kind:'finished',stopped:'session-ended'});
 expect(count(fake.calls,'/v1/requests')).toBe(0);
});
