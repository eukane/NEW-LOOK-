/* 줄 위의 극장 — Cloudflare Workers 릴레이 (Durable Object 1개 = 방 1개)
 * server.js 와 같은 프로토콜입니다. 게임 계산은 호스트 브라우저가 하고, 여기서는 중계만 합니다.
 *   GET /            → assembly.html
 *   GET /health      → {ok:true}
 *   WS  /ws?create=1 → 새 방 (방 코드 발급)
 *   WS  /ws?room=ABCD → 방 참가
 */
import HTML from '../assembly.html';

const MAXP=4, A='ABCDEFGHJKLMNPQRSTUVWXYZ';
const genCode=()=>{ const r=crypto.getRandomValues(new Uint8Array(4)); let c=''; for(const b of r) c+=A[b%A.length]; return c; };

export default {
  async fetch(req, env){
    const u=new URL(req.url);
    if(u.pathname==='/ws'){
      if(req.headers.get('Upgrade')!=='websocket') return new Response('websocket only',{status:426});
      let code;
      if(u.searchParams.get('create')){
        for(let k=0;k<30;k++){
          const c=genCode(), stub=env.ROOMS.get(env.ROOMS.idFromName(c));
          const r=await stub.fetch('https://room/claim'); if(r.status===200){ code=c; break; }
        }
        if(!code) return new Response('no room',{status:503});
        return env.ROOMS.get(env.ROOMS.idFromName(code)).fetch('https://room/ws?code='+code+'&create=1',req);
      }
      code=String(u.searchParams.get('room')||'').toUpperCase().slice(0,4);
      return env.ROOMS.get(env.ROOMS.idFromName(code||'____')).fetch('https://room/ws?code='+code,req);
    }
    if(u.pathname==='/health') return Response.json({ok:true});
    if(u.pathname==='/'||u.pathname==='/index.html'||u.pathname==='/assembly.html')
      return new Response(HTML,{headers:{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-cache'}});
    return new Response('not found',{status:404});
  }
};

export class Room{
  constructor(state, env){ this.conns=new Map(); this.host=null; this.code=''; this.started=false; this.claimedAt=0; }
  async fetch(req){
    const u=new URL(req.url);
    if(u.pathname==='/claim'){   // 방 코드 선점 (비어 있거나 만료됐을 때만)
      if(this.conns.size||Date.now()-this.claimedAt<30000) return new Response('taken',{status:409});
      this.claimedAt=Date.now(); this.started=false; return new Response('ok');
    }
    const pair=new WebSocketPair(), cli=pair[0], srv=pair[1]; srv.accept();
    const c={ws:srv,id:-1,nick:'',room:true};
    srv.addEventListener('message',e=>{ let m; try{ m=JSON.parse(typeof e.data==='string'?e.data:new TextDecoder().decode(e.data)); }catch(_){ return; } try{ this.handle(c,m,u); }catch(err){ console.error(err); } });
    const gone=()=>this.leave(c); srv.addEventListener('close',gone); srv.addEventListener('error',gone);
    return new Response(null,{status:101,webSocket:cli});
  }
  send(c,o){ try{ c.ws.send(typeof o==='string'?o:JSON.stringify(o)); }catch(_){} }
  lobby(){ return {t:'lobby',room:this.code,started:this.started,players:[...this.conns.values()].sort((a,b)=>a.id-b.id).map(c=>({id:c.id,nick:c.nick,host:c===this.host}))}; }
  bcastLobby(){ const m=this.lobby(); for(const c of this.conns.values()) this.send(c,m); }
  handle(c,m,u){
    if(m.t==='create'){
      if(c.id>=0||this.host||!u.searchParams.get('create')) return;
      this.code=u.searchParams.get('code'); this.host=c; c.id=0; c.nick=String(m.nick||'방장').slice(0,12); this.conns.set(0,c);
      this.send(c,{t:'created',room:this.code,id:0}); this.bcastLobby(); return; }
    if(m.t==='join'){
      if(c.id>=0) return;
      if(!this.host){ this.send(c,{t:'error',msg:'그런 방이 없습니다'}); return; }
      if(this.started){ this.send(c,{t:'error',msg:'이미 시작된 방입니다'}); return; }
      if(this.conns.size>=MAXP){ this.send(c,{t:'error',msg:'방이 가득 찼습니다'}); return; }
      let id=1; while(this.conns.has(id)) id++; c.id=id; c.nick=String(m.nick||('손님'+id)).slice(0,12); this.conns.set(id,c);
      this.send(c,{t:'joined',room:this.code,id}); this.bcastLobby(); return; }
    if(c.id<0) return;
    if(m.t==='start'){ if(c!==this.host||this.started) return; this.started=true; this.bcastLobby(); const pl=this.lobby().players; for(const o of this.conns.values()) this.send(o,{t:'started',players:pl}); return; }
    if(m.t==='to'){
      const out=JSON.stringify({t:'msg',from:c.id,m:m.m});
      if(m.to==='host'){ if(c!==this.host) this.send(this.host,out); }
      else if(m.to==='all'){ for(const o of this.conns.values()) if(o!==c) this.send(o,out); }
      else { const o=this.conns.get(+m.to); if(o&&o!==c) this.send(o,out); }
      return; }
    if(m.t==='ping'){ this.send(c,{t:'pong',n:m.n}); return; }
  }
  leave(c){
    if(c.left) return; c.left=true;
    if(c.id<0){ return; }
    this.conns.delete(c.id);
    if(c===this.host){ for(const o of this.conns.values()){ this.send(o,{t:'closed',reason:'호스트가 나갔습니다'}); o.left=true; try{ o.ws.close(1000,'host left'); }catch(_){} } this.conns.clear(); this.host=null; this.claimedAt=0; return; }
    if(this.host) this.send(this.host,{t:'left',id:c.id});
    if(!this.started) this.bcastLobby();
  }
}
