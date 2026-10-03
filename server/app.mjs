import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { resolve, extname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { random, hash, keys, exportPublic, importPublic, verifyBytes, signEnvelope, parseJson, enrollText, approvalText, confirmationCode } from './crypto.mjs';

const webRoot = fileURLToPath(new URL('../web/', import.meta.url));
const mime = {'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.svg':'image/svg+xml','.webmanifest':'application/manifest+json'};
class HttpError extends Error { constructor(status,message){super(message);this.status=status;} }
const must=(x,status,message)=>{if(!x) throw new HttpError(status,message)};
const nonce=x=>typeof x==='string' && /^[A-Za-z0-9_-]{43}$/.test(x);

export function createApp({origin='http://localhost:5173', now=Date.now, serverKeys=keys(), allowSimulator=true}={}) {
  const sessions=new Map(), accounts=new Map(), tickets=new Map(), devices=new Map(), challenges=new Map(), tokenToDevice=new Map();
  const serverPublicKey=exportPublic(serverKeys.publicKey);
  function json(res,status,value,headers={}){res.writeHead(status,{'content-type':'application/json; charset=utf-8','cache-control':'no-store',...headers});res.end(JSON.stringify(value));}
  async function body(req){let raw='';for await(const c of req){raw+=c;if(raw.length>16384)throw new HttpError(413,'Request too large');}try{return JSON.parse(raw||'{}')}catch{throw new HttpError(400,'Invalid JSON')}}
  function cookie(req){const m=/(?:^|;\s*)nearkey_session=([A-Za-z0-9_-]+)/.exec(req.headers.cookie||'');return m?.[1];}
  function session(req){const token=cookie(req),s=token&&sessions.get(hash(token));must(s&&s.expires>now(),401,'Demo session expired');return s;}
  function browserWrite(req){must(req.headers.origin===origin && req.headers['x-nearkey']==='1',403,'Wrong origin');}
  function device(req){const token=/^Bearer ([A-Za-z0-9_-]{43})$/.exec(req.headers.authorization||'')?.[1];const id=token&&tokenToDevice.get(hash(token));const d=id&&devices.get(id);must(d,401,'Phone not paired');return d;}
  function getChallenge(id,accountId){const c=challenges.get(id);must(c&&c.accountId===accountId,404,'Challenge not found');if(c.expiresAt<=now()&&c.state==='pending')c.state='expired';return c;}
  async function handler(req,res){
    res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Referrer-Policy','no-referrer');res.setHeader('X-Frame-Options','SAMEORIGIN');
    res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'self'");
    try {
      must(req.headers.host===new URL(origin).host,403,'Wrong host');
      const path=new URL(req.url,origin).pathname;
      if(req.method==='GET'&&path==='/api/config') return json(res,200,{origin,publicKey:serverPublicKey,allowSimulator,protocol:2});
      if(req.method==='POST'&&path==='/api/demo/session'){
        browserWrite(req);let s;try{s=session(req)}catch{}
        if(s)return json(res,200,{accountId:s.accountId});
        const raw=random(),accountId=randomUUID(),binding=random();
        accounts.set(accountId,{id:accountId,name:'Alex Morgan',balance:2486250,transfers:[],audit:[]});
        sessions.set(hash(raw),{accountId,binding,expires:now()+8*60*60*1000});
        return json(res,201,{accountId},{'set-cookie':`nearkey_session=${raw}; HttpOnly; SameSite=Strict; Path=/; Max-Age=28800`});
      }
      if(req.method==='GET'&&path==='/api/account'){
        const s=session(req),a=accounts.get(s.accountId),d=[...devices.values()].find(x=>x.accountId===a.id);
        return json(res,200,{...a,device:d?{id:d.id,label:d.label,publicKey:d.publicKey,format:d.format,kind:d.kind}:null,recipients:[{id:'elena',name:'Elena Morgan',bank:'Cedar Credit Union',last4:'4821',known:true},{id:'james',name:'James Wilson',bank:'Harbor Bank',last4:'7056',known:true},{id:'horizon',name:'Horizon Home Services',bank:'Crescent Bank',last4:'9032',known:false}]});
      }
      if(req.method==='POST'&&path==='/api/enrollment-ticket'){
        browserWrite(req);const s=session(req);must(![...devices.values()].some(d=>d.accountId===s.accountId),409,'Phone already paired');
        const ticket=random();tickets.set(hash(ticket),{accountId:s.accountId,expires:now()+5*60*1000});return json(res,201,{ticket,origin,publicKey:serverPublicKey,expiresAt:now()+5*60*1000});
      }
      if(req.method==='POST'&&path==='/api/enroll'){
        const b=await body(req),t=typeof b.ticket==='string'&&tickets.get(hash(b.ticket));must(t&&t.expires>now(),403,'Pairing ticket expired');
        must(b.kind==='android'||(allowSimulator&&b.kind==='simulator'),403,'Simulator disabled');must(['der','ieee-p1363'].includes(b.format),400,'Bad signature format');
        try{importPublic(b.publicKey)}catch{throw new HttpError(400,'Bad public key')}
        must(verifyBytes(b.publicKey,Buffer.from(enrollText(b.ticket,b.publicKey)),b.signature,b.format),403,'Enrollment signature invalid');
        must(![...devices.values()].some(d=>d.accountId===t.accountId),409,'Phone already paired');
        const id=randomUUID(),rawToken=random(),d={id,accountId:t.accountId,publicKey:b.publicKey,format:b.format,kind:b.kind,label:String(b.label||'NearKey phone').slice(0,40),tokenHash:hash(rawToken)};
        devices.set(id,d);tokenToDevice.set(d.tokenHash,id);tickets.delete(hash(b.ticket));accounts.get(t.accountId).audit.unshift({event:'device_paired',at:now()});
        return json(res,201,{deviceId:id,deviceToken:rawToken,origin,publicKey:serverPublicKey,accountName:'Alex Morgan'});
      }
      if(req.method==='POST'&&path==='/api/device/revoke'){
        browserWrite(req);const s=session(req);const d=[...devices.values()].find(x=>x.accountId===s.accountId);if(d){devices.delete(d.id);tokenToDevice.delete(d.tokenHash);for(const c of challenges.values())if(c.accountId===s.accountId&&c.state==='pending')c.state='cancelled';}
        return json(res,200,{ok:true});
      }
      if(req.method==='POST'&&path==='/api/challenges'){
        browserWrite(req);const s=session(req),a=accounts.get(s.accountId),b=await body(req),d=[...devices.values()].find(x=>x.accountId===a.id);must(d,409,'Pair a phone first');
        must(nonce(b.browserNonce),400,'Fresh browser nonce required');const recipients={elena:['Elena Morgan','Cedar Credit Union','4821',true],james:['James Wilson','Harbor Bank','7056',true],horizon:['Horizon Home Services','Crescent Bank','9032',false]};const r=recipients[b.recipientId];must(r,400,'Bad recipient');
        must(Number.isSafeInteger(b.amount)&&b.amount>=100&&b.amount<=1000000&&b.amount<=a.balance,400,'Bad amount');
        must(![...challenges.values()].some(c=>c.accountId===a.id&&c.state==='pending'&&c.expiresAt>now()),409,'Finish current request first');
        const id=randomUUID(),expiresAt=now()+180000;const obj={v:2,id,accountId:a.id,sessionBinding:s.binding,origin,expiresAt,serverNonce:random(),browserNonce:b.browserNonce,device:{id:d.id,publicKey:d.publicKey,format:d.format},operation:{type:'transfer',amount:b.amount,currency:'USD',recipientId:b.recipientId,recipientName:r[0],bank:r[1],accountLast4:r[2],newRecipient:!r[3],note:String(b.note||'').slice(0,80)}};
        const envelope=signEnvelope(serverKeys.privateKey,obj);challenges.set(id,{id,accountId:a.id,sessionBinding:s.binding,deviceId:d.id,envelope,expiresAt,state:'pending',attempts:0});a.audit.unshift({event:'request_created',at:now(),detail:`$${(b.amount/100).toFixed(2)} to ${r[0]}`});
        return json(res,201,{envelope});
      }
      if(req.method==='GET'&&path==='/api/device/pending'){
        const d=device(req);const c=[...challenges.values()].filter(x=>x.deviceId===d.id&&x.state==='pending'&&x.expiresAt>now()).sort((a,b)=>b.expiresAt-a.expiresAt)[0];return json(res,200,{request:c?{envelope:c.envelope}:null});
      }
      const dm=/^\/api\/device\/challenges\/([a-f0-9-]{36})$/.exec(path);
      if(req.method==='GET'&&dm){const d=device(req),c=getChallenge(dm[1],d.accountId);must(c.deviceId===d.id&&c.state==='pending',409,'Request closed');return json(res,200,{envelope:c.envelope});}
      const cm=/^\/api\/challenges\/([a-f0-9-]{36})(?:\/(finish|cancel))?$/.exec(path);
      if(cm){const s=session(req),c=getChallenge(cm[1],s.accountId);
        if(req.method==='GET'&&!cm[2])return json(res,200,{state:c.state,expiresAt:c.expiresAt});
        must(req.method==='POST',405,'Method not allowed');browserWrite(req);
        if(cm[2]==='cancel'){if(c.state==='pending')c.state='cancelled';return json(res,200,{state:c.state});}
        must(cm[2]==='finish',404,'Not found');must(c.state==='pending',409,`Request is ${c.state}`);must(c.expiresAt>now(),409,'Request expired');must(c.sessionBinding===s.binding,403,'Wrong session');
        const b=await body(req),obj=parseJson(c.envelope.payload),d=devices.get(c.deviceId);must(d,403,'Phone removed');
        const ok=verifyBytes(d.publicKey,Buffer.from(approvalText(c.envelope.payload)),b.phoneSignature,d.format);if(!ok){c.attempts++;if(c.attempts>=5)c.state='locked';throw new HttpError(403,'Phone approval invalid');}
        must(typeof b.code==='string'&&/^\d{8}$/.test(b.code)&&confirmationCode(b.phoneSignature,c.id)===b.code,403,'Confirmation code mismatch');
        must(obj.operation.amount<=accounts.get(s.accountId).balance,409,'Insufficient balance');
        c.state='consumed';const a=accounts.get(s.accountId);a.balance-=obj.operation.amount;const receipt=randomUUID();a.transfers.unshift({id:receipt,recipient:obj.operation.recipientName,amount:obj.operation.amount,at:now(),challengeId:c.id});a.audit.unshift({event:'transfer_completed',at:now(),detail:receipt});
        return json(res,200,{receipt,balance:a.balance,amount:obj.operation.amount,recipient:obj.operation.recipientName});
      }
      if(path.startsWith('/api/'))throw new HttpError(404,'API not found');
      must(req.method==='GET'||req.method==='HEAD',405,'Method not allowed');const mapped=path==='/'?'index.html':path==='/phone'?'phone.html':decodeURIComponent(path.slice(1));const file=resolve(webRoot,mapped);must(file.startsWith(resolve(webRoot)+sep),403,'Forbidden');try{must((await stat(file)).isFile(),404,'Not found');const data=await readFile(file);res.writeHead(200,{'content-type':mime[extname(file)]||'application/octet-stream'});res.end(req.method==='HEAD'?undefined:data)}catch(e){if(e instanceof HttpError)throw e;throw new HttpError(404,'Not found')}
    } catch(e){json(res,e.status||500,{error:e.status?e.message:'Unexpected server error'})}
  }
  const server=createServer(handler);return {server,serverPublicKey,state:{sessions,accounts,tickets,devices,challenges}};
}
