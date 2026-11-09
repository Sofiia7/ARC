/** RPC failure handling for the reputation sync: which errors may move a source read to the next node, and which fields of an error are safe to log. */
import {ContractFunctionExecutionError,ContractFunctionRevertedError,ContractFunctionZeroDataError,ExecutionRevertedError,HttpRequestError,RpcError,RpcRequestError,TimeoutError,type BaseError} from 'viem';

function* causes(error:unknown){
  for(let e=error,depth=0;e!==null&&typeof e==='object'&&depth<16;e=(e as {cause?:unknown}).cause,depth++) yield e;
}
const transportError=(e:unknown):e is HttpRequestError|TimeoutError|RpcRequestError=>e instanceof HttpRequestError||e instanceof TimeoutError||e instanceof RpcRequestError;

/**
 * True only when the node itself failed: HTTP failure, timeout or a JSON-RPC error object.
 * Reverts, empty contract data and every integrity check (plain Error) are never node
 * failures, so they fail closed exactly as before and are not retried on another node.
 */
export function isNodeFailure(error:unknown):boolean{
  let node=false;
  for(const e of causes(error)){
    if(e instanceof ContractFunctionRevertedError||e instanceof ContractFunctionZeroDataError||e instanceof ExecutionRevertedError) return false;
    if(transportError(e)||e instanceof RpcError) node=true;
  }
  return node;
}

/** JSON-RPC method of the failed request. HttpRequestError keeps the body; TimeoutError and RpcRequestError keep it only in metaMessages. */
function rpcMethod(e:BaseError&{body?:unknown}){
  let body=e.body;
  if(body===undefined){
    const line=e.metaMessages?.find(m=>m.startsWith('Request body: '));
    if(line) try{body=JSON.parse(line.slice('Request body: '.length));}catch{/* unparseable body: no method */}
  }
  const methods=(Array.isArray(body)?body:[body]).map(b=>(b as {method?:unknown}|undefined)?.method)
    .filter((m):m is string=>typeof m==='string'&&/^[A-Za-z0-9_]{1,64}$/.test(m));
  return methods.length?[...new Set(methods)].join(','):undefined;
}

/** Strips every known secret (whole value plus its URL parts), then any URL and any long token, then truncates. */
function scrub(text:string,secrets:readonly (string|undefined)[]){
  const fragments=new Set<string>();
  for(const secret of secrets){
    if(!secret) continue;
    fragments.add(secret);
    try{
      const u=new URL(secret);
      for(const part of [u.username,u.password,...u.hostname.split('.'),...u.pathname.split('/'),...u.searchParams.values()]) if(part.length>=8) fragments.add(part);
    }catch{/* not a URL: the whole value is already listed */}
  }
  let out=text;
  for(const f of [...fragments].sort((a,b)=>b.length-a.length)) out=out.split(f).join('[redacted]');
  return out.replace(/[a-z][a-z0-9+.-]*:\/\/[^\s"'<>]+/gi,'[url]').replace(/[A-Za-z0-9_-]{32,}/g,'[redacted]').replace(/\s+/g,' ').trim().slice(0,200);
}

export type SafeErrorFields={status?:number;rpcCode?:number;rpcMethod?:string;contractFunction?:string;details?:string};
/**
 * Diagnostic fields that never carry a URL, key or request parameters. viem puts the RPC URL
 * (path keys included) into `message` and `metaMessages`, so neither is ever returned.
 */
export function safeErrorFields(error:unknown,secrets:readonly (string|undefined)[]=[]):SafeErrorFields{
  const fields:SafeErrorFields={};
  for(const e of causes(error)){
    if(fields.contractFunction===undefined&&e instanceof ContractFunctionExecutionError&&/^[A-Za-z0-9_]{1,64}$/.test(e.functionName)) fields.contractFunction=e.functionName;
    if(fields.status===undefined&&e instanceof HttpRequestError&&Number.isInteger(e.status)) fields.status=e.status;
    if(fields.rpcCode===undefined&&(e instanceof RpcRequestError||e instanceof RpcError)&&Number.isInteger(e.code)) fields.rpcCode=e.code;
    if(transportError(e)){
      fields.rpcMethod??=rpcMethod(e);
      if(fields.details===undefined&&typeof e.details==='string'&&e.details) fields.details=scrub(e.details,secrets);
    }
  }
  return fields;
}
