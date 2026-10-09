import test from 'node:test';
import assert from 'node:assert/strict';
import {needsMirrorUpdate,type OwnerRecord} from '../src/reputation.js';
const record:OwnerRecord={identityOwner:'0x1111111111111111111111111111111111111111',sourceChain:8453,sourceBlock:20n,paidJobs:1n,scoreSum:95n};
test('an unchanged newer source snapshot costs no gas; a revocation does update',()=>{
 assert.equal(needsMirrorUpdate(record,[1n,95n,10n,100n]),false);
 assert.equal(needsMirrorUpdate({...record,paidJobs:0n,scoreSum:0n},[1n,95n,10n,100n]),true);
});
test('first zero snapshot is still delivered; mirror conflicts and newer blocks fail closed',()=>{
 assert.equal(needsMirrorUpdate({...record,paidJobs:0n,scoreSum:0n},[0n,0n,0n,0n]),true);
 assert.throws(()=>needsMirrorUpdate(record,[1n,95n,21n,100n]));
 assert.throws(()=>needsMirrorUpdate(record,[1n,94n,20n,100n]));
});
