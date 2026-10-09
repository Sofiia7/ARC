import { decodeFunctionData, parseAbi, type Address, type Hex } from 'viem';
const approveAbi=parseAbi(['function approve(address spender,uint256 amount) returns(bool)']);
export function validateMeraTransaction(tx:{from?:string;to?:string;value?:string;chainId?:string},config:{account:Address;chainId:number;adapter:Address;usdc:Address;identity:Address}){
  if(!tx.to||![config.adapter,config.usdc,config.identity].some(a=>a.toLowerCase()===tx.to!.toLowerCase()))throw Error('Passkey transaction target is outside NadBounty');
  if(tx.from&&tx.from.toLowerCase()!==config.account.toLowerCase())throw Error('Passkey account mismatch');
  if(tx.chainId&&BigInt(tx.chainId)!==BigInt(config.chainId))throw Error('Passkey transaction chain mismatch');
  if(BigInt(tx.value??'0')!==0n)throw Error('Passkey integration does not send native MON');
}
export function validateMeraApproval(data:Hex,adapter:Address){
  const decoded=decodeFunctionData({abi:approveAbi,data});
  if(decoded.args[0].toLowerCase()!==adapter.toLowerCase()||decoded.args[1]>100000000n)throw Error('Only NadBounty approvals up to 100 USDC are allowed');
}
