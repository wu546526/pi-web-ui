#!/usr/bin/env node
// pi-tunnel CLI —— 主人设备侧: 主动连 server + 本机控制 API（C 档 P1：文件/设备枚举/审计）。
// 用法: node cli.mjs [ws://host:8765]   ({{TOKEN}}/{{SERVER}} 由 server /cli 下载时注入)
// 控制 API: 仅监听 127.0.0.1:<随机>，要求 X-Tunnel-Token 头（=当前令牌）；
//           白名单/能力开关由面板下发（config 消息），本地持久化 ~/.pi-tunnel-cli.json。
// 审计: 每次 fs 操作记录，5s 批量上报 server 聚合（面板审计视图）。
import net from 'node:net';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { homedir } from 'node:os';

const argSrv = process.argv.slice(2).find(a => /^wss?:\/\//.test(a)); // 只认 ws(s):// 形态, 防 zsh 粘贴行内注释垃圾参数
const SERVER = argSrv || '{{SERVER}}';
const TOKEN  = process.env.PI_TUNNEL_TOKEN || '{{TOKEN}}';
const sockMap = new Map();
const CFG_FILE = path.join(homedir(), '.pi-tunnel-cli.json');

if (typeof WebSocket === 'undefined') {
  console.error(`需要 Node >= 22 (全局 WebSocket)。当前 ${process.version}`);
  process.exit(1);
}

// ── 本地配置（白名单/能力开关）——server config 下发时覆盖并持久化 ──────────────
let cfg = { fsRead: true, fsWrite: false, whitelist: ['~/Downloads'] };
try { Object.assign(cfg, JSON.parse(fs.readFileSync(CFG_FILE, 'utf8'))); } catch {}
cfg.whitelist = (cfg.whitelist || []).map(p => p.startsWith('~') ? path.join(homedir(), p.slice(1)) : p);
cfg.whitelist = [...new Set(cfg.whitelist)];
const saveCfg = () => { try { fs.writeFileSync(CFG_FILE, JSON.stringify(cfg, null, 2)); } catch {} };

const expandHome = p => p === '~' ? homedir() : (p.startsWith('~/') ? path.join(homedir(), p.slice(2)) : p);
const inWhitelist = p => {
  const rp = path.resolve(p);
  return cfg.whitelist.some(w => {
    const rw = path.resolve(w);
    return rp === rw || rp.startsWith(rw + path.sep);
  });
};
const json = (res, code, obj) => { try { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); } catch {} };

// ── 审计 buffer（5s 批量上报 server）──────────────────────────────────────────
const auditBuf = [];
const audit = (op, detail) => auditBuf.push({ ts: Date.now(), op, detail: String(detail).slice(0, 300) });

// ── 设备枚举（跨 OS，30s 缓存；只读清单）───────────────────────────────────────
let devCache = null, devAt = 0;
function listDevices(cb) {
  if (devCache && Date.now() - devAt < 30000) return cb(null, devCache);
  const plat = os.platform();
  const out = { platform: plat, usb: [], disks: [] };
  const fin = () => { devCache = out; devAt = Date.now(); cb(null, out); };
  const dfDisks = done => execFile('df', ['-kP'], { timeout: 8000, maxBuffer: 1e6 }, (e, so) => {
    if (!e) for (const line of so.split('\n').slice(1)) {
      const c = line.trim().split(/\s+/);
      if (c.length >= 9) {
        const mnt = c.slice(8).join(' ');
        if (/^\/Volumes\//.test(mnt) || /\/media\/|\/mnt\//.test(mnt)) {
          out.disks.push({ mount: mnt, totalGB: +(c[1] / 1048576).toFixed(1), usedGB: +(c[2] / 1048576).toFixed(1) });
        }
      }
    }
    done();
  });
  if (plat === 'darwin') {
    execFile('system_profiler', ['SPUSBDataType', '-json'], { timeout: 12000, maxBuffer: 8e6 }, (e, so) => {
      try {
        const j = JSON.parse(so);
        const walk = items => (items ?? []).forEach(it => {
          if (it._name && !/Bus$/i.test(it._name)) out.usb.push({ name: it._name, vendor: it.vendor_id ?? '' });
          if (it._items) walk(it._items);
        });
        for (const k of Object.keys(j)) walk(j[k]?._items);
      } catch {}
      dfDisks(fin);
    });
  } else if (plat === 'linux') {
    execFile('lsusb', { timeout: 8000 }, (e, so) => {
      if (!e) out.usb = so.split('\n').filter(Boolean).map(l => ({ name: l.split(/:\s+/).pop() ?? l }));
      dfDisks(fin);
    });
  } else { // win32: 磁盘走 PowerShell；USB 枚举留 P4
    execFile('powershell', ['-NoProfile', '-Command',
      "Get-CimInstance Win32_LogicalDisk -Filter 'DriveType=3' | ForEach-Object { \"$($_.DeviceID)|$([math]::Round($_.Size/1GB,1))|$([math]::Round($_.FreeSpace/1GB,1))\" }"],
      { timeout: 12000 }, (e, so) => {
        if (!e) for (const l of so.split('\n').filter(Boolean)) {
          const [mount, total, free] = l.split('|');
          out.disks.push({ mount, totalGB: +total, freeGB: +free });
        }
        fin();
      });
  }
}

// ── 控制服务（仅 127.0.0.1；token 头鉴权；白名单硬校验）─────────────────────────
let ctrlPort = 0;
const ctrlSrv = http.createServer((req, res) => {
  if (req.headers['x-tunnel-token'] !== TOKEN) return json(res, 403, { error: 'unauthorized' });
  const u = new URL(req.url, 'http://local');
  try {
    if (u.pathname === '/health') {
      return json(res, 200, { ok: true, name: os.hostname(), os: `${os.platform()} ${os.release()} ${os.arch()}`, fsRead: !!cfg.fsRead, fsWrite: !!cfg.fsWrite, whitelist: cfg.whitelist });
    }
    if (!cfg.fsRead) return json(res, 403, { error: '文件读取能力未开启（面板授权）' });
    if (u.pathname === '/fs/list') {
      const p = path.resolve(expandHome(u.searchParams.get('path') || homedir()));
      if (!inWhitelist(p)) { audit('fs.list.denied', p); return json(res, 403, { error: 'path 不在白名单内' }); }
      const entries = fs.readdirSync(p, { withFileTypes: true }).slice(0, 2000).map(e => {
        let size = 0, mtime = 0;
        try { const st = fs.statSync(path.join(p, e.name)); size = st.size; mtime = st.mtimeMs; } catch {}
        return { name: e.name, dir: e.isDirectory(), size, mtime };
      });
      audit('fs.list', p);
      return json(res, 200, { path: p, entries });
    }
    if (u.pathname === '/fs/read') {
      const p = path.resolve(expandHome(u.searchParams.get('path')));
      if (!inWhitelist(p)) { audit('fs.read.denied', p); return json(res, 403, { error: 'path 不在白名单内' }); }
      const st = fs.statSync(p);
      if (st.isDirectory()) return json(res, 400, { error: '是目录，用 /fs/list' });
      if (st.size > 4 * 1024 * 1024) return json(res, 413, { error: '文件超 4MB（P2 支持大文件）' });
      audit('fs.read', p);
      return json(res, 200, { path: p, size: st.size, b64: fs.readFileSync(p).toString('base64') });
    }
    if (u.pathname === '/fs/write' && req.method === 'POST') {
      if (!cfg.fsWrite) { audit('fs.write.denied', u.searchParams.get('path') || ''); return json(res, 403, { error: '写开关未开启（面板授权）' }); }
      let body = '';
      req.on('data', c => { body += c; if (body.length > 6 * 1024 * 1024) req.destroy(); });
      req.on('end', () => {
        try {
          const { path: p, b64 } = JSON.parse(body || '{}');
          const rp = path.resolve(expandHome(p || ''));
          if (!inWhitelist(rp)) { audit('fs.write.denied', rp); return json(res, 403, { error: 'path 不在白名单内' }); }
          fs.writeFileSync(rp, Buffer.from(b64 || '', 'base64'));
          audit('fs.write', rp);
          return json(res, 200, { ok: true, path: rp, size: Buffer.from(b64 || '', 'base64').length });
        } catch (e) { return json(res, 400, { error: String(e.message || e) }); }
      });
      return;
    }
    if (u.pathname === '/fs/browse') { // 目录浏览：仅目录名（供面板选白名单路径）；不做白名单校验但审计覆盖，文件内容仍需白名单
      if (!cfg.fsRead) { audit('fs.browse.denied', ''); return json(res, 403, { error: '读开关未开启' }); }
      const raw = u.searchParams.get('path') || '~';
      try {
        const p = path.resolve(expandHome(raw));
        const dirs = fs.readdirSync(p, { withFileTypes: true })
          .filter(e => e.isDirectory() && !e.name.startsWith('.'))
          .map(e => e.name).sort();
        audit('fs.browse', raw);
        return json(res, 200, { path: p, parent: path.dirname(p), home: homedir(), dirs });
      } catch (e) { audit('fs.browse.denied', raw); return json(res, 400, { error: String(e.code || e.message || e) }); }
    }
    if (u.pathname === '/devices') {
      audit('devices.enum', os.platform());
      return listDevices((err, d) => json(res, err ? 500 : 200, err ? { error: err } : d));
    }
    return json(res, 404, { error: 'not found' });
  } catch (e) { return json(res, 500, { error: String(e.message || e) }); }
});

let wsRef = null;
let reconnectDelay = 5000; // 被 kicked 时拉长退避，防同名实例互踢抖动
function connect() {
  let url;
  try {
    url = new URL(SERVER.replace(/^http/, 'ws') + '/agent?token=' + TOKEN);
  } catch {
    console.error(`URL 非法: SERVER=${JSON.stringify(SERVER)} TOKEN=${JSON.stringify(TOKEN)}`);
    process.exit(1);
  }
  const ws = new WebSocket(url);
  wsRef = ws;
  ws.onopen = () => {
    reconnectDelay = 5000; // 成功连接后恢复常规重连间隔
    console.log(`[tunnel] 已连接 ${SERVER} @ ${os.hostname()}（控制API :${ctrlPort}）`);
    ws.send(JSON.stringify({ t: 'hello', name: process.env.PI_TUNNEL_NAME || os.hostname(), os: `${os.platform()} ${os.release()} ${os.arch()}`, ctrlPort }));
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
    else if (m.t === 'config') { // 面板下发：能力开关/白名单
      if (Array.isArray(m.whitelist)) cfg.whitelist = m.whitelist.map(p => p.startsWith('~') ? path.join(homedir(), p.slice(1)) : p);
      if (typeof m.fsRead === 'boolean') cfg.fsRead = m.fsRead;
      if (typeof m.fsWrite === 'boolean') cfg.fsWrite = m.fsWrite;
      saveCfg();
      console.log(`[tunnel] 配置已更新: fsRead=${cfg.fsRead} fsWrite=${cfg.fsWrite} 白名单=${cfg.whitelist.length} 项`);
      try { ws.send(JSON.stringify({ t: 'hello', name: process.env.PI_TUNNEL_NAME || os.hostname(), os: `${os.platform()} ${os.release()} ${os.arch()}`, ctrlPort })); } catch {}
    }
    else if (m.t === 'ctrl') { // 面板经 server 转发的控制请求：自连本机 ctrlSrv，复用全部鉴权/审计
      const rq = http.get({ host: '127.0.0.1', port: ctrlPort, path: m.url, headers: { 'X-Tunnel-Token': TOKEN } }, r => {
        let body = '';
        r.on('data', d => body += d);
        r.on('end', () => { try { ws.send(JSON.stringify({ t: 'ctrl-resp', rid: m.rid, status: r.statusCode, body: JSON.parse(body) })); } catch {} });
      });
      rq.on('error', () => { try { ws.send(JSON.stringify({ t: 'ctrl-resp', rid: m.rid, status: 500, body: { error: 'ctrl unreachable' } })); } catch {} });
    }
    else if (m.t === 'uninstall') { // 面板下发：自卸载（停常驻→删配置与 CLI 文件→退出）
      audit('cli.uninstall', os.platform());
      try { if (ws.readyState === 1) ws.send(JSON.stringify({ t: 'audit', items: auditBuf.splice(0) })); } catch {}
      const home = homedir();
      const run = (cmd, args) => new Promise(r => execFile(cmd, args, { timeout: 8000 }, () => r()));
      const rm = f => { try { fs.rmSync(f, { force: true }); } catch {} };
      const stopPersist = process.platform === 'darwin'
        ? run('launchctl', ['bootout', `gui/${process.getuid()}/com.pi-tunnel.cli`])
            .then(() => rm(path.join(home, 'Library/LaunchAgents/com.pi-tunnel.cli.plist')))
        : process.platform === 'win32'
          ? run('schtasks', ['/Delete', '/TN', 'pi-tunnel', '/F'])
          : run('systemctl', ['--user', 'stop', 'pi-tunnel-cli'])
              .then(() => run('systemctl', ['--user', 'disable', 'pi-tunnel-cli']))
              .then(() => rm(path.join(home, '.config/systemd/user/pi-tunnel-cli.service')))
              .then(() => run('systemctl', ['--user', 'daemon-reload']));
      stopPersist.finally(() => {
        rm(path.join(home, 'pi-tunnel-cli.mjs'));
        rm(CFG_FILE);
        console.log('[tunnel] 已卸载（常驻+文件），退出');
        try { ws.close(); } catch {}
        setTimeout(() => process.exit(0), 400);
      });
      return;
    }
    else if (m.t === 'kicked') { // 同名新实例接管：长退避，避免互踢循环
      reconnectDelay = 60000;
      console.log('[tunnel] 此设备有新实例接管，60s 后重连');
      try { ws.close(); } catch {}
      return;
    }
  };
  ws.onclose = ev => {
    console.log(`[tunnel] 断开(${ev.code ?? ''}) ${reconnectDelay / 1000}s后重连`);
    for (const s of sockMap.values()) s.destroy();
    sockMap.clear();
    setTimeout(connect, reconnectDelay);
  };
  ws.onerror = () => {};
}

// 审计批量上报（重连后继续）
setInterval(() => {
  if (auditBuf.length && wsRef && wsRef.readyState === 1) {
    wsRef.send(JSON.stringify({ t: 'audit', items: auditBuf.splice(0) }));
  }
}, 5000);

// 先起控制服务，再连隧道（hello 需要 ctrlPort）
ctrlSrv.listen(0, '127.0.0.1', () => {
  ctrlPort = ctrlSrv.address().port;
  console.log(`[ctrl] 控制API监听 127.0.0.1:${ctrlPort}（fsRead=${cfg.fsRead} fsWrite=${cfg.fsWrite} 白名单=${cfg.whitelist.length}）`);
  connect();
});
