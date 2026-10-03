export const enc=new TextEncoder(),dec=new TextDecoder();
export function b64(bytes){let s='';for(const b of new Uint8Array(bytes))s+=String.fromCharCode(b);return btoa(s).replaceAll('+','-').replaceAll('/','_').replaceAll('=','')}
export function unb64(s){return Uint8Array.from(atob(s.replaceAll('-','+').replaceAll('_','/')+'='.repeat((4-s.length%4)%4)),x=>x.charCodeAt(0))}
export const randomNonce=()=>b64(crypto.getRandomValues(new Uint8Array(32)));
export const importPublic=s=>crypto.subtle.importKey('spki',unb64(s),{name:'ECDSA',namedCurve:'P-256'},true,['verify']);
export const exportPublic=async k=>b64(await crypto.subtle.exportKey('spki',k));
export const newKey=()=>crypto.subtle.generateKey({name:'ECDSA',namedCurve:'P-256'},false,['sign','verify']);
export const signText=async(k,t)=>b64(await crypto.subtle.sign({name:'ECDSA',hash:'SHA-256'},k,enc.encode(t)));
export function derToRaw(input){const b=new Uint8Array(input);let p=0;if(b[p++]!==0x30)throw Error('Bad DER');let len=b[p++];if(len&0x80){const n=len&0x7f;len=0;for(let i=0;i<n;i++)len=(len<<8)|b[p++]}if(b[p++]!==2)throw Error('Bad DER');const rl=b[p++],r=b.slice(p,p+rl);p+=rl;if(b[p++]!==2)throw Error('Bad DER');const sl=b[p++],s=b.slice(p,p+sl);const out=new Uint8Array(64);for(const [v0,o] of [[r,0],[s,32]]){const v=v0.length===33&&v0[0]===0?v0.slice(1):v0;if(v.length>32)throw Error('Bad DER int');out.set(v,o+32-v.length)}return out}
export async function verifyText(publicKey,signature,text,format='ieee-p1363'){const sig=format==='der'?derToRaw(unb64(signature)):unb64(signature);return crypto.subtle.verify({name:'ECDSA',hash:'SHA-256'},await importPublic(publicKey),sig,enc.encode(text))}
export async function verifyEnvelope(publicKey,envelope){const key=await importPublic(publicKey);const ok=await crypto.subtle.verify({name:'ECDSA',hash:'SHA-256'},key,unb64(envelope.signature),unb64(envelope.payload));if(!ok)throw Error('Bank signature invalid');return JSON.parse(dec.decode(unb64(envelope.payload)))}
export async function sha(bytes){return b64(await crypto.subtle.digest('SHA-256',bytes))}
export async function approvalText(payload){return `NEARKEY-APPROVE-V2\n${await sha(unb64(payload))}`}
export async function confirmationCode(signature,challengeId){const a=unb64(signature),b=enc.encode('\n'+challengeId),all=new Uint8Array(a.length+b.length);all.set(a);all.set(b,a.length);const d=new Uint8Array(await crypto.subtle.digest('SHA-256',all));let n=0n;for(const x of d.slice(0,8))n=(n<<8n)|BigInt(x);return (n%100000000n).toString().padStart(8,'0')}
export const enrollText=(ticket,key)=>`NEARKEY-ENROLL-V2\n${ticket}\n${key}`;
