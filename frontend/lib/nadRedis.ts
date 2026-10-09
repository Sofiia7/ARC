/** Server-only Upstash REST. Errors deliberately exclude URLs and credentials. */
export async function nadRedis<T>(...command:(string|number)[]):Promise<T>{
  const url=process.env.NAD_UPSTASH_REDIS_REST_URL,token=process.env.NAD_UPSTASH_REDIS_REST_TOKEN;
  if(!url||!token)throw Error('NadBounty Redis is not configured');
  const parsed=new URL(url);
  if(parsed.protocol!=='https:'||!parsed.hostname.endsWith('.upstash.io'))throw Error('Unexpected Redis endpoint');
  const response=await fetch(url,{method:'POST',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},body:JSON.stringify(command),signal:AbortSignal.timeout(10000),cache:'no-store'});
  if(!response.ok)throw Error('Redis request failed');
  const data=await response.json();if(data.error)throw Error('Redis command failed');return data.result as T;
}
