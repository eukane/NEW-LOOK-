#!/usr/bin/env node
/* 줄 위의 극장 — 온라인 릴레이 서버 (의존성 없음)
 *   node server.js            → http://localhost:8080  (PORT 환경변수로 변경)
 * - assembly.html 을 그대로 서빙하므로 친구들은 이 주소로 접속하면 됩니다.
 * - 방 생성/참가, 호스트 ↔ 클라이언트 메시지 중계만 합니다 (게임 계산은 호스트 브라우저가 합니다).
 */
const http=require('http'), fs=require('fs'), path=require('path'), crypto=require('crypto');
const LAG=+process.env.LAG||0;   // 개발용: 중계 지연(ms) 흉내
const PORT=+process.env.PORT||8080, HTML=path.join(__dirname,'assembly.html'), MAXP=4, MAXBUF=512*1024;
const rooms=new Map();   // code -> {code,host:Conn,conns:Map<id,Conn>,started:false}

/* ---------- 최소 WebSocket (RFC 6455) ---------- */
class Conn{
  constructor(sock){ this.sock=sock; this.buf=Buffer.alloc(0); this.frag=null; this.alive=true; this.lastPong=Date.now(); this.room=null; this.id=-1; this.nick=''; this.closed=false;
    sock.on('data',d=>this.onData(d)); sock.on('close',()=>this.onClose()); sock.on('error',()=>this.onClose()); }
  onData(d){
    this.buf=Buffer.concat([this.buf,d]); if(this.buf.length>4*1024*1024){ this.sock.destroy(); return; }
    for(;;){
      const b=this.buf; if(b.length<2) return;
      const fin=(b[0]&0x80)!==0, op=b[0]&0x0f, masked=(b[1]&0x80)!==0; let len=b[1]&0x7f, off=2;
      if(len===126){ if(b.length<4) return; len=b.readUInt16BE(2); off=4; } else if(len===127){ if(b.length<10) return; len=Number(b.readBigUInt64BE(2)); off=10; }
      if(len>2*1024*1024){ this.sock.destroy(); return; }
      const need=off+(masked?4:0)+len; if(b.length<need) return;
      let payload=b.subarray(off+(masked?4:0),need);
      if(masked){ const m=b.subarray(off,off+4), out=Buffer.allocUnsafe(len); for(let i=0;i<len;i++) out[i]=payload[i]^m[i&3]; payload=out; } else payload=Buffer.from(payload);
      this.buf=b.subarray(need);
      if(op===0x8){ this.close(); return; }
      if(op===0x9){ this.sendRaw(0xA,payload); continue; }
      if(op===0xA){ this.lastPong=Date.now(); continue; }
      if(op===0x1||op===0x2||op===0x0){
        if(op!==0x0) this.frag={op,parts:[payload]}; else if(this.frag) this.frag.parts.push(payload); else continue;
        if(fin){ const msg=Buffer.concat(this.frag.parts); this.frag=null; this.onText(msg.toString('utf8')); }
      }
    }
  }
  sendRaw(op,payload){
    if(this.closed||!this.sock.writable) return false; const len=payload.length; let head;
    if(len<126){ head=Buffer.from([0x80|op,len]); } else if(len<65536){ head=Buffer.alloc(4); head[0]=0x80|op; head[1]=126; head.writeUInt16BE(len,2); } else { head=Buffer.alloc(10); head[0]=0x80|op; head[1]=127; head.writeBigUInt64BE(BigInt(len),2); }
    this.sock.write(Buffer.concat([head,payload])); return true;
  }
  send(obj,lossy){ if(lossy&&this.sock.writableLength>MAXBUF) return false; const buf=Buffer.from(typeof obj==='string'?obj:JSON.stringify(obj),'utf8'); if(LAG>0){ setTimeout(()=>this.sendRaw(0x1,buf),LAG); return true; } return this.sendRaw(0x1,buf); }
  close(){ if(this.closed) return; try{ this.sendRaw(0x8,Buffer.alloc(0)); }catch(_){} this.sock.end(); this.onClose(); }
  onText(txt){ let m; try{ m=JSON.parse(txt); }catch(_){ return; } try{ handle(this,m); }catch(e){ console.error('handle error',e); } }
  onClose(){ if(this.closed) return; this.closed=true; leave(this); }
}

/* ---------- 방 ---------- */
const token=()=>crypto.randomBytes(12).toString('hex');
const genCode=()=>{ const A='ABCDEFGHJKLMNPQRSTUVWXYZ'; for(let k=0;k<50;k++){ let c=''; for(let i=0;i<4;i++) c+=A[crypto.randomInt(A.length)]; if(!rooms.has(c)) return c; } return null; };
const lobbyOf=r=>({t:'lobby',room:r.code,started:r.started,players:[...r.conns.values()].sort((a,b)=>a.id-b.id).map(c=>({id:c.id,nick:c.nick,host:c===r.host}))});
const bcastLobby=r=>{ const m=lobbyOf(r); for(const c of r.conns.values()) c.send(m); };
function handle(c,m){
  if(m.t==='create'){
    if(c.room) return; const code=genCode(); if(!code){ c.send({t:'error',msg:'방을 만들 수 없습니다'}); return; }
    const r={code,host:c,conns:new Map(),seats:new Map(),started:false}; rooms.set(code,r); c.room=r; c.id=0; c.nick=String(m.nick||'방장').slice(0,12); r.conns.set(0,c); const tk=token(); r.seats.set(0,{token:tk,nick:c.nick,conn:c});
    c.send({t:'created',room:code,id:0,token:tk}); bcastLobby(r); return; }
  if(m.t==='join'){
    if(c.room) return; const r=rooms.get(String(m.room||'').toUpperCase());
    if(!r){ c.send({t:'error',msg:'그런 방이 없습니다'}); return; }
    if(r.started){ c.send({t:'error',msg:'이미 시작된 방입니다'}); return; }
    if(r.conns.size>=MAXP){ c.send({t:'error',msg:'방이 가득 찼습니다'}); return; }
    let id=1; while(r.seats.has(id)) id++; c.room=r; c.id=id; c.nick=String(m.nick||('손님'+id)).slice(0,12); r.conns.set(id,c); const tk=token(); r.seats.set(id,{token:tk,nick:c.nick,conn:c});
    c.send({t:'joined',room:r.code,id,token:tk}); bcastLobby(r); return; }
  if(m.t==='rejoin'){   // 끊겼다가 같은 토큰으로 자리 복귀 (시작된 방, 방장 제외)
    if(c.room) return; const r=rooms.get(String(m.room||'').toUpperCase()); let seat=null,sid=-1;
    if(r) for(const [i,st] of r.seats) if(i!==0&&st.token===m.token){ seat=st; sid=i; }
    if(!r||!seat||!r.started||!r.host){ c.send({t:'error',msg:'다시 들어갈 수 없습니다 (방이 닫혔거나 자리가 없습니다)'}); return; }
    const old=seat.conn; if(old&&old!==c){ old.replaced=true; r.conns.delete(sid); try{ old.sock.end(); }catch(_){} }
    c.room=r; c.id=sid; c.nick=seat.nick; seat.conn=c; r.conns.set(sid,c);
    c.send({t:'joined',room:r.code,id:sid,rejoin:true,token:seat.token}); if(old&&old!==c) r.host.send({t:'left',id:sid}); r.host.send({t:'back',id:sid}); return; }
  const r=c.room; if(!r) return;
  if(m.t==='start'){ if(c!==r.host||r.started) return; r.started=true; bcastLobby(r); for(const o of r.conns.values()) o.send({t:'started',players:lobbyOf(r).players}); return; }
  if(m.t==='to'){   // {t:'to',to:id|'host'|'all',m:{...},lossy?}
    const out=JSON.stringify({t:'msg',from:c.id,m:m.m});
    if(m.to==='host'){ if(c!==r.host) r.host.send(out,m.lossy); }
    else if(m.to==='all'){ for(const o of r.conns.values()) if(o!==c) o.send(out,m.lossy); }
    else { const o=r.conns.get(+m.to); if(o&&o!==c) o.send(out,m.lossy); }
    return; }
  if(m.t==='ping'){ c.send({t:'pong',n:m.n}); return; }
}
function leave(c){
  const r=c.room; if(!r) return; c.room=null; if(c.replaced) return;
  if(r.conns.get(c.id)===c) r.conns.delete(c.id);
  if(c!==r.host){ const st=r.seats.get(c.id); if(r.started){ if(st&&st.conn===c) st.conn=null; } else r.seats.delete(c.id); }
  if(c===r.host){ for(const o of r.conns.values()){ o.send({t:'closed',reason:'호스트가 나갔습니다'}); o.room=null; o.sock.end(); } r.conns.clear(); rooms.delete(r.code); return; }
  if(r.host) r.host.send({t:'left',id:c.id}); if(!r.started) bcastLobby(r);
  if(!r.conns.size) rooms.delete(r.code);
}

/* ---------- HTTP ---------- */
const server=http.createServer((req,res)=>{
  const u=req.url.split('?')[0];
  if(u==='/'||u==='/index.html'||u==='/assembly.html'){ fs.readFile(HTML,(e,d)=>{ if(e){ res.writeHead(500); res.end('assembly.html not found'); return; } res.writeHead(200,{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-cache'}); res.end(d); }); return; }
  if(u==='/health'){ res.writeHead(200,{'Content-Type':'application/json'}); res.end(JSON.stringify({ok:true,rooms:rooms.size})); return; }
  res.writeHead(404); res.end('not found');
});
server.on('upgrade',(req,sock)=>{
  if((req.url||'').split('?')[0]!=='/ws'||!req.headers['sec-websocket-key']){ sock.destroy(); return; }
  const key=crypto.createHash('sha1').update(req.headers['sec-websocket-key']+'258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
  sock.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: '+key+'\r\n\r\n'); sock.setNoDelay(true);
  new Conn(sock);
});
const conns=new Set(); server.on('upgrade',(req,sock)=>{ /* tracked via Conn */ });
setInterval(()=>{ for(const r of rooms.values()) for(const c of r.conns.values()){ if(Date.now()-c.lastPong>70000){ c.sock.destroy(); continue; } c.sendRaw(0x9,Buffer.alloc(0)); } },20000);
if(require.main===module) server.listen(PORT,'0.0.0.0',()=>{ console.log('줄 위의 극장 서버: http://localhost:'+PORT); try{ const nets=require('os').networkInterfaces(); for(const k in nets) for(const n of nets[k]) if(n.family==='IPv4'&&!n.internal) console.log('  같은 와이파이 친구: http://'+n.address+':'+PORT); }catch(_){} });
module.exports={server,rooms};
