import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readNadJson,NadRequestError} from '../lib/nadRequest';
test('rejects an oversized streamed body without trusting Content-Length',async()=>{
  for(const length of [undefined,'1']){
    const request=new Request('https://example.test',{method:'POST',body:'{"text":"too large"}',headers:length?{'content-length':length}:{}});
    await assert.rejects(()=>readNadJson(request,8),(e:unknown)=>e instanceof NadRequestError&&e.status===413);
  }
});
test('accepts bounded Unicode JSON and rejects malformed JSON',async()=>{
  assert.deepEqual(await readNadJson(new Request('https://example.test',{method:'POST',body:'{"text":"Привет"}'}),100),{text:'Привет'});
  await assert.rejects(()=>readNadJson(new Request('https://example.test',{method:'POST',body:'not json'}),100),(e:unknown)=>e instanceof NadRequestError&&e.status===400);
});
