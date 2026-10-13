import { hashTypedData, recoverMessageAddress, recoverTypedDataAddress } from 'viem';

export function safeTypedData(call) {
  const message = { ...call.message };
  for (const key of ['value', 'safeTxGas', 'baseGas', 'gasPrice', 'nonce']) message[key] = BigInt(message[key]);
  const typed = { domain: call.domain, types: call.types, primaryType: 'SafeTx', message };
  if (hashTypedData(typed) !== call.hash) throw new Error('Safe payload hash mismatch');
  return typed;
}

// Safe v1.4.1: v=31/32 means personal_sign over the raw 32-byte SafeTx hash.
export async function recoverSafeSignature(call, raw, scheme = 'safe') {
  if (!/^0x[0-9a-f]{130}$/i.test(raw)) throw new Error('Expected a 65-byte signature');
  const typed = safeTypedData(call);
  let v = Number.parseInt(raw.slice(-2), 16);
  if (v === 0 || v === 1) v += 27;
  if (scheme === 'personal_sign') {
    if (v !== 27 && v !== 28) throw new Error('Invalid personal signature recovery byte');
    v += 4;
  } else if (scheme !== 'safe') throw new Error('Unsupported signature scheme');
  if (![27, 28, 31, 32].includes(v)) throw new Error('Unsupported Safe signature recovery byte');
  const signature = raw.slice(0, -2) + v.toString(16);
  const signer = v > 30
    ? await recoverMessageAddress({ message: { raw: call.hash }, signature: raw.slice(0, -2) + (v - 4).toString(16) })
    : await recoverTypedDataAddress({ ...typed, signature });
  return { signer, signature };
}
