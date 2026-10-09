import { createSecp256k1SigningSession } from '@category-labs/mera';
import { toViemAccount } from '@category-labs/mera/viem';
import { HDKey } from '@scure/bip32';
import { entropyToMnemonic, mnemonicToSeedSync } from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english.js';

/** Standard BIP39 + Ethereum BIP44 path; caller owns and clears the PRF input. */
export function meraIdentityFromPrf(prf:Uint8Array){
  if(prf.length!==32)throw Error('Mera PRF must contain 32 bytes');
  const seed=mnemonicToSeedSync(entropyToMnemonic(prf,wordlist));
  let root:HDKey|undefined,child:HDKey|undefined;
  try{
    root=HDKey.fromMasterSeed(seed);child=root.derive("m/44'/60'/0'/0/0");
    if(!child.privateKey)throw Error('Passkey key derivation failed');
    const session=createSecp256k1SigningSession({privateKey:child.privateKey});
    try{return{session,account:toViemAccount(session)};}catch(error){session.end();throw error;}
  }finally{seed.fill(0);root?.wipePrivateData();child?.wipePrivateData();}
}
