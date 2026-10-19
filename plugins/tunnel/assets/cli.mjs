#!/usr/bin/env node
// pi-tunnel A档 CLI —— 主人设备侧: 主动连 server, 代为执行 TCP(含DNS)
// 用法: node cli.mjs [ws://host:8765]   ({{TOKEN}}/{{SERVER}} 由 server /cli 下载时注入)
import net from 'node:net';
import os from 'node:os';

const argSrv = process.argv.slice(2).find(a => /^wss?:\/\//.test(a)); // 只认 ws(s):// 形态, 防 zsh 粘贴行内注释垃圾参数
const SERVER = argSrv || '{{SERVER}}';
const TOKEN  = process.env.PI_TUNNEL_TOKEN || '{{TOKEN}}';
const sockMap = new Map();

if (typeof WebSocket === 'undefined') {
  console.error(`需要 Node >= 22 (全局 WebSocket)。当前 ${process.version}`);
  process.exit(1);
}

function connect() {
  let url;
  try {
    url = new URL(SERVER.replace(/^http/, 'ws') + '/agent?token=' + TOKEN);
  } catch {
    console.error(`URL 非法: SERVER=${JSON.stringify(SERVER)} TOKEN=${JSON.stringify(TOKEN)}`);
    process.exit(1);
  }
  const ws = new WebSocket(url);
  ws.onopen = () => {
    console.log(`[tunnel] 已连接 ${SERVER} @ ${os.hostname()}`);
    ws.send(JSON.stringify({ t: 'hello', name: process.env.PI_TUNNEL_NAME || os.hostname(), os: `${os.platform()} ${os.release()} ${os.arch()}` }));
  };
  ws.onmessage = ev => {
    let m; try { m = JSON.parse(typeof ev.data === 'string' ? ev.data : Buffer.from(ev.data).toString()); } catch { return; }
    if (m.t === 'connect') {
      const s = net.connect({ host: m.host, port: m.port }, () =>
        ws.send(JSON.stringify({ t: 'open', id: m.id })));
      s.on('data', d => ws.send(JSON.stringify({ t: 'data', id: m.id, b64: d.toString('base64') })));
      s.on('end',  () => ws.send(JSON.stringify({ t: 'end',  id: m.id })));
      s.on('error', e => ws.send(JSON.stringify({ t: 'err', id: m.id, msg: String(e.code || e.message || e) })));
      s.on('close', () => { ws.send(JSON.stringify({ t: 'close', id: m.id })); sockMap.delete(m.id); });
      sockMap.set(m.id, s);
    } else if (m.t === 'data')  sockMap.get(m.id)?.write(Buffer.from(m.b64, 'base64'));
    else if (m.t === 'end')     sockMap.get(m.id)?.end();
    else if (m.t === 'close') { sockMap.get(m.id)?.destroy(); sockMap.delete(m.id); }
  };
  ws.onclose = ev => {
    console.log(`[tunnel] 断开(${ev.code ?? ''}) 5s后重连`);
    for (const s of sockMap.values()) s.destroy();
    sockMap.clear();
    setTimeout(connect, 5000);
  };
  ws.onerror = () => {};
}
connect();
