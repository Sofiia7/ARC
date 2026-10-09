import {isAddress,zeroAddress,type Address} from 'viem';
export const FACILITATOR='https://x402-facilitator.molandak.org';
export function configuration(env:NodeJS.ProcessEnv){
  const network=env.NAD_NETWORK??'monad-testnet';
  if(network!=='monad-testnet'&&network!=='monad-mainnet')throw Error('Expected explicit Monad network');
  const chainId=network==='monad-testnet'?10143:143;
  const adapter=env.NAD_BOUNTY_ADAPTER_ADDRESS??(chainId===10143?'0xf88B980B3AB1CD5A2Befd9c0B88B70196f215020':'');
  const payTo=env.NAD_X402_PAY_TO;
  if(!isAddress(adapter)||adapter===zeroAddress)throw Error('Missing deployed V4.8 adapter');
  if(!payTo||!isAddress(payTo)||payTo===zeroAddress)throw Error('NAD_X402_PAY_TO must be an explicit treasury address');
  const rpc=env.NAD_RPC_URL??(chainId===10143?'https://testnet-rpc.monad.xyz':'https://rpc.monad.xyz');
  if(new URL(rpc).protocol!=='https:')throw Error('HTTPS RPC required');
  const port=Number(env.PORT??3402);
  if(!Number.isInteger(port)||port<1||port>65535)throw Error('Invalid port');
  return {network,chainId,adapter:adapter as Address,payTo:payTo as Address,rpc,port,
    usdc:chainId===10143?'0x534b2f3A21130d7a60830c2Df862319e593943A3':'0x754704Bc059F8C67012fEd69BC8A327a5aafb603'};
}
