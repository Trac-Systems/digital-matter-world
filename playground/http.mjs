import { publicIdentities } from '../rules/src/trac-address.js';
import { createServer } from 'node:http';
import { readFile, stat, realpath } from 'node:fs/promises';
import { join, extname, resolve, sep } from 'node:path';
import { timingSafeEqual, randomUUID, randomBytes } from 'node:crypto';
import { ROOT, origin, json, maybe, save, integer } from './common.mjs';
import { projectEvent } from './api.mjs';

export const stringify=value=>JSON.stringify(publicIdentities(value),(_,v)=>typeof v==='bigint'?v.toString():v);
const equalSecret=(value,expected)=>{const a=Buffer.from(value),b=Buffer.from(expected);return a.length===b.length&&timingSafeEqual(a,b);};
export function authorized(req,token,session) {
  if(equalSecret(req.headers.authorization??'','Bearer '+token))return true;
  const cookies=(req.headers.cookie??'').split(';').map(c=>c.trim()).filter(c=>c.startsWith('dmw_session='));
  return !!session&&cookies.length===1&&equalSecret(cookies[0].slice('dmw_session='.length),session);
}
export async function body(req){if(!/^application\/json(?:;|$)/i.test(req.headers['content-type']??''))throw Object.assign(Error('json_content_type_required'),{status:415});let size=0;const chunks=[];for await(const c of req){size+=c.length;if(size>65536)throw Object.assign(Error('body_limit'),{status:413});chunks.push(c);}try{const b=JSON.parse(Buffer.concat(chunks).toString());if(!b||Array.isArray(b)||typeof b!=='object')throw Error();return b;}catch{throw Object.assign(Error('invalid_json'),{status:400});}}
export class Jobs {
  constructor(directory,emit,dispatch){this.directory=directory;this.emit=emit;this.dispatch=dispatch;this.rows=new Map();this.tail=Promise.resolve();this.accepting=true;this.pending=0;}
  async init(){for(const row of await maybe(join(this.directory,'jobs.json'))??[]){if(['running','queued'].includes(row.state)){row.state='failed';row.error='interrupted; inspect chain state before resubmitting';}this.rows.set(row.id,row);}}
  async persist(){while(this.rows.size>1000){const row=this.rows.values().next().value;if(['queued','running'].includes(row.state))break;this.rows.delete(row.id);}await save(join(this.directory,'jobs.json'),[...this.rows.values()].slice(-1000));}
  async submit(type,args){if(!this.accepting)throw Error('stopping');if(this.pending>=32)throw Object.assign(Error('job_queue_full'),{status:429});const row={id:randomUUID(),state:'queued',type,created:Date.now()};this.rows.set(row.id,row);await this.persist();this.pending++;
    this.tail=this.tail.then(async()=>{row.state='running';await this.persist();this.emit('job',row);try{row.result=await this.dispatch(type,args);row.state='complete';}catch(e){row.state='failed';row.error=e.message;}row.finished=Date.now();await this.persist();this.emit('job',row);}).finally(()=>{this.pending--;});
    return row;
  }
}
export async function serveControl({token,events,route,publicEvents,port=59000}) {
  const consoleRoot=join(ROOT,'playground/console');const streams=new Set(),session=randomBytes(32).toString('hex');
  const localEvent=event=>projectEvent(event,(publicEvents?'/api/lab/feed/':'/api/feed/')+event.sequence);
  const server=createServer(async(req,res)=>{
    const send=(status,value)=>{res.writeHead(status,{'content-type':'application/json','cache-control':'no-store'});res.end(stringify(value));};
    try{
      if(req.headers.host!==`127.0.0.1:${server.address().port}`)return send(403,{error:'host_not_allowed'});
      const url=new URL(req.url,origin);
      if(url.pathname==='/'&&url.searchParams.has('t')){
        res.setHeader('cache-control','no-store');res.setHeader('referrer-policy','no-referrer');
        if(req.method!=='GET')return send(405,{error:'method_not_allowed'});
        if(url.searchParams.getAll('t').length!==1||!equalSecret(url.searchParams.get('t'),token))return send(401,{error:'unauthorized'});
        res.writeHead(303,{'location':'/','set-cookie':`dmw_session=${session}; HttpOnly; SameSite=Strict; Path=/api`});res.end();return;
      }
      if(url.pathname.startsWith('/api/')){
        if(req.headers.origin && req.headers.origin!==origin)return send(403,{error:'origin_not_allowed'});
        if(req.headers['sec-fetch-site']==='cross-site')return send(403,{error:'origin_not_allowed'});
        if(req.headers.origin===origin){res.setHeader('access-control-allow-origin',origin);res.setHeader('vary','Origin');}
        if(req.method==='OPTIONS'){res.writeHead(204,{'access-control-allow-methods':'GET, POST, OPTIONS','access-control-allow-headers':'Authorization, Content-Type, Last-Event-ID'});res.end();return;}
        if(!authorized(req,token,session))return send(401,{error:'unauthorized'});
        if(req.method==='GET'&&publicEvents&&url.pathname==='/api/events'){
          const rawAfter=req.headers['last-event-id'];
          if(rawAfter!==undefined&&(!/^\d+$/.test(rawAfter)||!Number.isSafeInteger(Number(rawAfter))))return send(400,{error:'invalid_event_cursor'});
          let after=rawAfter===undefined?null:Number(rawAfter),closed=false,busy=false;
          if(after===null)after=(await publicEvents({limit:1})).events[0]?.sequence??0;
          res.writeHead(200,{'content-type':'text/event-stream','cache-control':'no-store','connection':'keep-alive'});res.write(': connected\n\n');
          const poll=async()=>{if(closed||busy)return;busy=true;try{
            const page=await publicEvents({since:after,order:'asc',limit:200});
            for(const event of page.events){if(closed)break;if(res.writableLength>1000000){res.end();break;}
              res.write(`id: ${event.sequence}\nevent: update\ndata: ${stringify(event)}\n\n`);after=event.sequence;}
          }catch{if(!closed)res.write(': public feed temporarily unavailable\n\n');}finally{busy=false;}};
          const timer=setInterval(()=>void poll(),1000),heartbeat=setInterval(()=>res.write(': heartbeat\n\n'),15000);
          req.on('close',()=>{closed=true;clearInterval(timer);clearInterval(heartbeat);});
          void poll();return;
        }
        if(req.method==='GET'&&(url.pathname==='/api/lab/events'||!publicEvents&&url.pathname==='/api/events')){
          res.writeHead(200,{'content-type':'text/event-stream','cache-control':'no-store','connection':'keep-alive'});
          const after=Number(req.headers['last-event-id']);
          if(req.headers['last-event-id']!==undefined&&Number.isSafeInteger(after)&&after>=0)for(const event of events.filter(e=>e.sequence>after).slice(-200))res.write(`id: ${event.sequence}\nevent: update\ndata: ${stringify(localEvent(event))}\n\n`);
          res.write(': connected\n\n');
          streams.add(res);const timer=setInterval(()=>res.write(': heartbeat\n\n'),15000);req.on('close',()=>{clearInterval(timer);streams.delete(res);});return;
        }
        const value=await route(req.method,url,req.method==='POST'?await body(req):undefined,{requesterSecret:req.headers['x-mint-requester-secret']});send(req.method==='POST'?202:200,value);return;
      }
      if(req.method!=='GET'&&req.method!=='HEAD')return send(405,{error:'method_not_allowed'});
      if(url.pathname==='/rules/src/trac-address.js'){res.writeHead(200,{'content-type':'text/javascript','cache-control':'no-cache','x-content-type-options':'nosniff'});res.end(req.method==='HEAD'?undefined:await readFile(new URL('../rules/src/trac-address.js',import.meta.url)));return;}
      let path=decodeURIComponent(url.pathname);if(path==='/')path='/index.html';
      if(path.includes('\0')||path.split('/').some(p=>p.startsWith('.')))return send(404,{error:'not_found'});
      const file=resolve(consoleRoot,'.'+path);if(!file.startsWith(consoleRoot+sep))return send(404,{error:'not_found'});
      let actual;try{actual=await realpath(file);}catch(e){if(['ENOENT','ENOTDIR','EACCES'].includes(e.code))return send(404,{error:'not_found'});throw e;}
      if(!actual.startsWith(consoleRoot+sep))return send(404,{error:'not_found'});
      if(!(await stat(actual)).isFile())return send(404,{error:'not_found'});
      const data=await readFile(actual);res.writeHead(200,{'content-type':({'.html':'text/html','.js':'text/javascript','.mjs':'text/javascript','.css':'text/css','.json':'application/json','.svg':'image/svg+xml','.woff2':'font/woff2','.png':'image/png'})[extname(file)]??'application/octet-stream','cache-control':'no-cache','x-content-type-options':'nosniff'});res.end(req.method==='HEAD'?undefined:data);
    }catch(e){if(!res.headersSent){const missing=['ENOENT','ENOTDIR','EISDIR','EACCES'].includes(e.code);send(missing?404:e.status??400,{error:missing?'not_found':e.code?'request_failed':e.message});}else res.end();}
  });
  server.requestTimeout=15000;server.headersTimeout=10000;
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(port,'127.0.0.1',resolve);});
  return {server,publish(event){const packet=`id: ${event.sequence}\nevent: update\ndata: ${stringify(localEvent(event))}\n\n`;for(const res of streams){if(res.writableLength>1000000){res.end();streams.delete(res);}else res.write(packet);}},async close(){for(const res of streams)res.end();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}};
}
