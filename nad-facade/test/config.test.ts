import {test} from 'node:test';import assert from 'node:assert/strict';
import {configuration} from '../src/config.js';
const treasury='0x74678c072Ca546f11466CD44eB7e21730a312a54';
test('testnet uses explicit treasury and isolated deployment',()=>{const c=configuration({NAD_X402_PAY_TO:treasury});assert.equal(c.chainId,10143);assert.equal(c.payTo,treasury);assert.equal(c.adapter,'0xf88B980B3AB1CD5A2Befd9c0B88B70196f215020');});
test('mainnet fails closed without deployment',()=>assert.throws(()=>configuration({NAD_NETWORK:'monad-mainnet',NAD_X402_PAY_TO:treasury})));
test('refuses missing recipient, invalid network and insecure RPC',()=>{assert.throws(()=>configuration({}));assert.throws(()=>configuration({NAD_NETWORK:'base-mainnet'}));assert.throws(()=>configuration({NAD_X402_PAY_TO:treasury,NAD_RPC_URL:'http://rpc.monad.xyz'}));});
