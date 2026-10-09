import {test} from 'node:test';
import assert from 'node:assert/strict';
import {encodeFunctionData,parseAbi,recoverMessageAddress,type Address} from 'viem';
import {meraIdentityFromPrf} from '../lib/meraDerivation';
import {validateMeraApproval,validateMeraTransaction} from '../lib/meraPolicy';
const account='0x1111111111111111111111111111111111111111' as Address;
const adapter='0x2222222222222222222222222222222222222222' as Address;
const usdc='0x3333333333333333333333333333333333333333' as Address;
const identity='0x4444444444444444444444444444444444444444' as Address;
const config={account,adapter,usdc,identity,chainId:10143};
test('Mera PRF recovery returns the same signing identity; ending the session disables signing',async()=>{
  const prf=new Uint8Array(32).fill(7),a=meraIdentityFromPrf(prf),b=meraIdentityFromPrf(prf);
  try{
    assert.equal(a.account.address,b.account.address);
    assert.equal(await recoverMessageAddress({message:'NadBounty recovery proof',signature:await a.account.signMessage({message:'NadBounty recovery proof'})}),a.account.address);
    a.session.end();await assert.rejects(a.account.signMessage({message:'ended'}));
    assert.throws(()=>meraIdentityFromPrf(new Uint8Array(31)));
  }finally{a.session.end();b.session.end();prf.fill(0);}
});
test('Passkey policy rejects chain, signer, target and native-value substitutions',()=>{
  assert.doesNotThrow(()=>validateMeraTransaction({to:adapter,from:account,chainId:'0x279f'},config));
  for(const tx of [{to:adapter,chainId:'0x8f'},{to:adapter,from:identity},{to:account},{to:adapter,value:'0x1'}])assert.throws(()=>validateMeraTransaction(tx,config));
});
test('Passkey USDC calls only permit bounded approvals to this adapter',()=>{
  const abi=parseAbi(['function approve(address spender,uint256 amount) returns(bool)','function transfer(address to,uint256 amount) returns(bool)']);
  assert.doesNotThrow(()=>validateMeraApproval(encodeFunctionData({abi,functionName:'approve',args:[adapter,100000000n]}),adapter));
  for(const data of [encodeFunctionData({abi,functionName:'approve',args:[identity,1n]}),encodeFunctionData({abi,functionName:'approve',args:[adapter,100000001n]}),encodeFunctionData({abi,functionName:'transfer',args:[adapter,1n]})])assert.throws(()=>validateMeraApproval(data,adapter));
});
