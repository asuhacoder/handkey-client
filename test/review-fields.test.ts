import {expect,test} from 'vitest';
import {parsePendingList} from '../src/parse.js';
import {wireRequest} from './helpers.js';
const invalid=[
 {ttl_seconds:-1},{ttl_seconds:1.5},{ttl_seconds:'3600'},
 {uses:-1},{uses:2.5},{uses:'2'},
 {unredacted:'true'},{unredacted:1},{unredacted:null},
 {command:['echo',42]},{command:'echo'},
 {bindings:{PASSWORD:42}},{bindings:[]},
];
test.each(invalid)('review-critical malformed spec %j is unreadable',patch=>{
 const request=wireRequest('bad','pending','not_started',undefined,'exec');
 expect(parsePendingList([{...request,spec:{...request.spec,...patch}},wireRequest('good')])).toMatchObject({kind:'ok',value:{unreadable:1,requests:[{id:'good'}]}});
});
test('absent review fields retain their explicit defaults',()=>{
 const request=wireRequest('one','pending','not_started',undefined,'exec');
 expect(parsePendingList([request])).toMatchObject({kind:'ok',value:{unreadable:0,requests:[{lease:{kind:'single-use'},operation:{kind:'exec',command:[],env:[],unmasked:false}}]}});
});
