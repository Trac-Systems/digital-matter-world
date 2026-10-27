import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { request as httpRequest } from 'node:http';
import { Jobs,serveControl } from '../http.mjs';
import { BUILD,origin } from '../common.mjs';

test('control requires a bearer token, rejects foreign origins and bounds JSON bodies',async t=>{
  const events=[],api=await serveControl({token:'test-token',events,port:0,route:async(method,url,args)=>({method,args})});t.after(()=>api.close());const url=`http://127.0.0.1:${api.server.address().port}`;
  let r=await fetch(url+'/api/status');assert.equal(r.status,401);
  r=await fetch(url+'/api/status',{headers:{authorization:'Bearer test-token',origin:'https://example.invalid'}});assert.equal(r.status,403);
  r=await fetch(url+'/api/status',{headers:{authorization:'Bearer test-token',origin}});assert.equal(r.status,200);assert.equal(r.headers.get('access-control-allow-origin'),origin);
  r=await fetch(url+'/api/mine',{method:'POST',headers:{authorization:'Bearer test-token','content-type':'application/json'},body:JSON.stringify({count:1})});assert.equal(r.status,202);assert.equal((await r.json()).args.count,1);
  r=await fetch(url+'/api/mine',{method:'POST',headers:{authorization:'Bearer test-token','content-type':'application/json'},body:'{"a":"'+'a'.repeat(66000)+'"}'});assert.equal(r.status,413);
  r=await fetch(url+'/api/mine',{method:'POST',headers:{authorization:'Bearer test-token','content-type':'application/json'},body:'[]'});assert.equal(r.status,400);
  const badHost=await new Promise((resolve,reject)=>{const q=httpRequest(url+'/api/status',{headers:{authorization:'Bearer test-token',host:'evil.invalid'}},res=>{res.resume();resolve(res.statusCode);});q.on('error',reject);q.end();});assert.equal(badHost,403);
  r=await fetch(url+'/%2edata/control.token');assert.equal(r.status,404);
});

test('unknown static paths and directories return plain 404s without filesystem details', async t => {
  const api = await serveControl({ token: 'test', events: [], port: 0, route: () => ({}) }); t.after(() => api.close());
  const origin = `http://127.0.0.1:${api.server.address().port}`;
  for (const path of ['/latest.json', '/missing/deep/file.js', '/index.html/child', '/fonts', '/%2edata/control.token']) {
    const response = await fetch(origin + path); assert.equal(response.status, 404, path);
    assert.deepEqual(await response.json(), { error: 'not_found' });
  }
});

test('jobs serialize mutations, preserve failures and never replay interrupted actions',async t=>{
  await mkdir(join(BUILD,'playground-tests'),{recursive:true});const directory=await mkdtemp(join(BUILD,'playground-tests/jobs-'));t.after(()=>rm(directory,{recursive:true}));
  const order=[],jobs=new Jobs(directory,()=>{},async(type,args)=>{order.push('start'+type);await new Promise(r=>setTimeout(r,10));if(type==='bad')throw Error('expected_failure');order.push('end'+type);return args;});
  await jobs.init();const a=await jobs.submit('a',{n:1}),b=await jobs.submit('b',{n:2}),bad=await jobs.submit('bad',{});await jobs.tail;
  assert.deepEqual(order,['starta','enda','startb','endb','startbad']);assert.equal(a.state,'complete');assert.equal(b.result.n,2);assert.equal(bad.state,'failed');
  jobs.rows.set('interrupted',{id:'interrupted',state:'running',type:'pay'});await jobs.persist();
  const restored=new Jobs(directory,()=>{},()=>{throw Error('must_not_run');});await restored.init();assert.equal(restored.rows.get('interrupted').state,'failed');
  assert.equal((await readFile(join(directory,'jobs.json'),'utf8')).includes('expected_failure'),true);
});

test('SSE replays retained events after Last-Event-ID without exposing authentication',async t=>{
  const api=await serveControl({token:'stream-token',events:[{sequence:1,type:'block',data:{tip:1}},{sequence:2,type:'block',data:{tip:2}}],port:0,route:()=>({})});t.after(()=>api.close());
  const controller=new AbortController();const r=await fetch(`http://127.0.0.1:${api.server.address().port}/api/events`,{headers:{authorization:'Bearer stream-token','last-event-id':'1'},signal:controller.signal});
  const reader=r.body.getReader(),chunk=new TextDecoder().decode((await reader.read()).value);assert.match(chunk,/id: 2/);assert.doesNotMatch(chunk,/id: 1|stream-token/);controller.abort();await reader.cancel().catch(()=>{});
});

test('login redirects before serving the page and authenticates API and SSE with an HttpOnly cookie',async t=>{
  const token='local-login-secret',api=await serveControl({token,events:[{sequence:1,type:'block',data:{tip:1}}],port:0,route:()=>({state:'ready'})});t.after(()=>api.close());
  const url=`http://127.0.0.1:${api.server.address().port}`;
  for(const query of ['wrong',token+'&t='+token]){
    const r=await fetch(url+'/?t='+query,{redirect:'manual'});assert.equal(r.status,401);assert.equal(r.headers.get('set-cookie'),null);
  }
  const login=await fetch(url+'/?t='+token,{redirect:'manual'});
  assert.equal(login.status,303);assert.equal(login.headers.get('location'),'/');assert.equal(await login.text(),'');
  assert.equal(login.headers.get('cache-control'),'no-store');assert.equal(login.headers.get('referrer-policy'),'no-referrer');
  const setCookie=login.headers.get('set-cookie');assert.match(setCookie,/; HttpOnly; SameSite=Strict; Path=\/api$/);assert.ok(!setCookie.includes(token));
  const cookie=setCookie.split(';')[0];
  let r=await fetch(url+'/api/status',{headers:{cookie}});assert.equal(r.status,200);
  r=await fetch(url+'/api/mine',{method:'POST',headers:{cookie,origin,'content-type':'application/json'},body:'{}'});assert.equal(r.status,202);
  for(const headers of [{cookie,origin:'http://foreign.invalid'},{cookie,'sec-fetch-site':'cross-site'}]){r=await fetch(url+'/api/status',{headers});assert.equal(r.status,403);}
  r=await fetch(url+'/api/status',{headers:{cookie:'dmw_session='+token}});assert.equal(r.status,401);
  r=await fetch(url+'/api/status',{headers:{cookie:cookie+'; '+cookie}});assert.equal(r.status,401);
  const controller=new AbortController();r=await fetch(url+'/api/events',{headers:{cookie,'last-event-id':'0'},signal:controller.signal});assert.equal(r.status,200);
  const reader=r.body.getReader(),chunk=new TextDecoder().decode((await reader.read()).value);assert.match(chunk,/id: 1/);assert.ok(!chunk.includes(token));assert.ok(!chunk.includes(cookie));controller.abort();await reader.cancel().catch(()=>{});
  const repeated=await fetch(url+'/?t='+token,{redirect:'manual'});assert.equal(repeated.headers.get('set-cookie'),setCookie);
});

test('control preserves upstream HTTP status codes for missing mint records',async t=>{
  const api=await serveControl({token:'test',events:[],port:0,route:()=>{throw Object.assign(Error('request_not_found'),{status:404});}});t.after(()=>api.close());
  const r=await fetch(`http://127.0.0.1:${api.server.address().port}/api/gateway/mint/unknown`,{headers:{authorization:'Bearer test'}});
  assert.equal(r.status,404);assert.deepEqual(await r.json(),{error:'request_not_found'});
});
