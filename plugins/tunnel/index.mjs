/**
 * pi-tunnel 插件服务端 —— 反向隧道（多设备共存）+ 本机 SOCKS5 出口。
 *
 * 数据面：AI --> SOCKS5(127.0.0.1:<socksPort>) --> WS(:<wsPort>) --> 出口设备 CLI --> 目标
 * DNS 解析发生在出口设备侧（SOCKS5 域名模式），测得即该设备所在网络真实结果。
 *
 * 多设备（B档，2026-10-19 主人拍板）：所有 CLI 共存在线（不互顶），server 维护设备表；
 *   SOCKS 流量走「当前出口设备」；出口掉线自动切换到剩余在线设备；面板可手动切换。
 *   CLI 零平台代码（Node net/WebSocket），hello 上报 name/os；旧 CLI 无 os 显示「—」兼容。
 *
 * 迁自 A 档 ~/projects/pi-tunnel/server/server.mjs（回环 + HTTPS 实测通过）。
 * ⚠ 全部逻辑内联本文件：宿主 plugins_reload 只对 index.mjs 做缓存击穿（?e=<epoch>），
 *   被 index 静态 import 的本地兄弟模块会命中 Node 模块缓存导致改动不生效。
 * 源仓：~/projects/pi-tunnel/plugin/（部署位 ~/.pi-web/plugins/tunnel/，cp 同步）。
 */
import net from 'node:net';
import os from 'node:os';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { createRequire } from 'node:module';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

// ── ws 库定位：插件与宿主同进程，从宿主入口(process.argv[1])向上解析即可命中
// 宿主 node_modules 里的 ws —— 对任何用户的 npm -g / 本地安装环境都成立，不硬编码路径。
function loadWs() {
	const tries = [];
	if (process.env.PI_TUNNEL_WS) tries.push(process.env.PI_TUNNEL_WS);
	try {
		const hostRequire = createRequire(process.argv[1] || import.meta.url);
		tries.push(hostRequire.resolve('ws'));
	} catch {}
	tries.push('ws'); // 插件目录自身/全局 node_modules 兑底
	for (const spec of tries) {
		try { return require(spec); } catch {}
	}
	throw new Error('pi-tunnel: 找不到 ws 库（设 PI_TUNNEL_WS=<ws包路径>）');
}

// ── 纯函数区（可离线单测）─────────────────────────────────────────────────────
/** 解析 SOCKS5 CONNECT 请求（RFC1928，仅 CMD=CONNECT；ATYP 1=IPv4 3=域名；4=IPv6 不支持）。 */
export function parseSocksConnect(buf) {
	if (buf.length < 7 || buf[0] !== 5 || buf[1] !== 1) return null;
	const atyp = buf[3];
	if (atyp === 1) return { host: Array.from(buf.slice(4, 8)).join('.'), port: buf.readUInt16BE(8) };
	if (atyp === 3) {
		const n = buf[4];
		if (buf.length < 5 + n + 2) return null;
		return { host: buf.slice(5, 5 + n).toString(), port: buf.readUInt16BE(5 + n) };
	}
	return null;
}
/** 自动探测本机内网 IPv4（面板生成常驻命令用，用户零配置；跨平台）。 */
export function detectLanIp() {
	for (const addrs of Object.values(os.networkInterfaces())) {
		for (const a of addrs ?? []) {
			if (a.family === 'IPv4' && !a.internal && /^(10\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.)/.test(a.address)) return a.address;
		}
	}
	return '';
}
/** HTML 转义（面板渲染设备名/OS 用，防注入习惯）。 */
export function escHtml(s) {
	return String(s).replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
}
function socksReply(c, code) {
	c.write(Buffer.from([5, code, 0, 1, 0, 0, 0, 0, 0, 0]));
}

export default {
	async activate(host) {
		const { WebSocketServer } = loadWs();
		const wsPort = Number(host.getSettings().wsPort ?? 8765);
		const socksPort = Number(host.getSettings().socksPort ?? 1080);
		// token 首次运行自动生成（代码里不硬编码；重置走面板或 POST /rotate）
		let token = host.storage.get('token');
		if (!token) {
			token = crypto.randomBytes(16).toString('hex');
			host.storage.set('token', token);
		}

		const state = {
			agents: new Map(),   // aid -> { ws, name, os, since, ctrlPort }
			activeAgentId: null, // 当前出口设备
			conns: new Map(),    // cid -> { c, replied, aid }
			nextId: 1, nextAid: 1,
			totalServed: 0, lastNotifyAt: 0,
			ctrlPending: new Map(), // P4: rid -> { resolve }（面板→设备控制请求-响应）
		};
		let ctrlSeq = 0;
		// POST body 读取：宿主 express.json 已消费流时用 req.body（手动读会永远等不到 end → ECONNRESET，20261019 实战根因）；
		// content-type 非 JSON（express.json 跳过）时兜底手动读。
		const readBodyJson = req => new Promise(resolve => {
			if (req.body !== undefined) return resolve(req.body ?? {});
			let b = '';
			req.on('data', c => { b += c; });
			req.on('end', () => { try { resolve(JSON.parse(b || '{}')); } catch { resolve({}); } });
			req.on('error', () => resolve({}));
		});
		// 面板经 server 中转到设备控制 API（复用 CLI 本机鉴权/审计，不走 SOCKS 开销）
		const deviceCtrl = (aid, url, opts = {}, timeoutMs = 8000) => new Promise(resolve => {
			const ag = agentById(aid);
			if (!ag) return resolve({ status: 503, body: { error: '设备不在线' } });
			if (!ag.ver) return resolve({ status: 400, body: { error: '该设备 CLI 为旧版，不支持此操作——请在面板「设备常驻化」重新安装后重试' } });
			const rid = `r${++ctrlSeq}`;
			const timer = setTimeout(() => { state.ctrlPending.delete(rid); resolve({ status: 504, body: { error: '设备响应超时' } }); }, timeoutMs);
			state.ctrlPending.set(rid, { resolve: v => { clearTimeout(timer); resolve(v); } });
			toAgent(aid, { t: 'ctrl', rid, url, method: opts.method || 'GET', body: opts.body });
		});
		// 模型三元组跟随：设备 pi 用 pi-web-ui 当前会话模型（自定义网关 provider 时桥接到对应网关）；解析失败返回 null，由面板手动兑底
		const resolveModelEnv = () => {
			try {
				const manual = host.storage.get('modelEnv');
				if (manual) {
					const j = JSON.parse(manual);
					if (j.baseUrl && j.apiKey && j.model) return { env: { OPENAI_BASE_URL: j.baseUrl, OPENAI_API_KEY: j.apiKey }, model: j.model };
				}
			} catch {}
			try {
				const home = os.homedir();
				const cs = JSON.parse(fs.readFileSync(path.join(home, '.pi-web/client-state.json'), 'utf8'));
				const m = JSON.stringify(cs).match(/"((?:wildwork|minimax-cn|ark|deepseek)\/[^"\\]+)"/); // 当前会话模型 ID（provider/渠道/型号）
				if (!m) return null;
				const full = m[1];
				const prov = full.split('/')[0];
				const gwModel = full.split('/').slice(1).join('/'); // 剥 provider 前缀 = 网关侧 ID
				const keys = JSON.parse(fs.readFileSync(path.join(home, '.pi/agent/provider-keys.json'), 'utf8'));
				const kv = keys?.[prov]?.keys?.[0];
				const apiKey = typeof kv === 'string' ? kv : (kv?.apiKey || kv?.value || kv?.key || '');
				if (!apiKey) return null;
				let base = '';
				if (prov === 'wildwork') base = lanIp ? `http://${lanIp}:${process.env.WILDWORK_GW_PORT || '7863'}/v1` : '';
				else return { env: {}, model: full }; // 标准 provider：设备端需已 pi auth，只传模型 ID
				if (!base) return null;
				return { env: { OPENAI_BASE_URL: base, OPENAI_API_KEY: apiKey }, model: gwModel };
			} catch { return null; }
		};
		// C 档 P1：审计环 + 设备能力配置（按 name 持久化，重连不丢授权）
		const auditRing = [];
		let devCfg = {};
		try { devCfg = JSON.parse(host.storage.get('devcfg') || '{}'); } catch {}
		const saveDevCfg = () => host.storage.set('devcfg', JSON.stringify(devCfg));
		const capsOf = name => devCfg[name] ?? { fsRead: true, fsWrite: false, whitelist: ['~/Downloads'] };
		const agentById = aid => {
			const a = state.agents.get(aid);
			return a && a.ws.readyState === 1 ? a : null;
		};
		const activeAgent = () => agentById(state.activeAgentId);
		const toAgent = (aid, obj) => {
			const a = state.agents.get(aid);
			if (a && a.ws.readyState === 1) a.ws.send(JSON.stringify(obj));
		};
		const pickAnyOnline = () => {
			for (const [id, a] of state.agents) if (a.ws.readyState === 1) return id;
			return null;
		};
		/** 出口掉线时自动切换到剩余在线设备；无设备则提示。 */
		const ensureActive = () => {
			if (agentById(state.activeAgentId)) return;
			state.activeAgentId = pickAnyOnline();
			if (state.activeAgentId) {
				const nm = state.agents.get(state.activeAgentId)?.name || state.activeAgentId;
				notifyDebounced('info', `网络隧道：出口设备已切换到 ${nm}`);
			}
		};
		const lanIp = detectLanIp(); // 面板生成常驻命令用（网络变化随插件重载自动更新）
		const statusSnapshot = () => ({
			running,
			rev: 'c1-p3', // 代码版本标记：reload 后可观测新代码是否激活
			lanIp,
			agentOnline: !!activeAgent(), // 兼容旧面板语义：当前出口在线
			activeAgentId: state.activeAgentId,
			devices: [...state.agents.entries()].map(([id, a]) => ({
				id, name: a.name || id, os: a.os || '', online: a.ws.readyState === 1, since: a.since,
				ctrlPort: a.ctrlPort ?? 0, ver: a.ver || '', caps: capsOf(a.name || id),
			})),
			activeConns: state.conns.size,
			totalServed: state.totalServed,
			tokenPrefix: `${token.slice(0, 4)}…`,
			wsPort, socksPort,
		});
		const cliCode = req => {
			let code = fs.readFileSync(path.join(__dirname, 'assets', 'cli.mjs'), 'utf8');
			return code
				.replaceAll('{{TOKEN}}', token)
				.replaceAll('{{SERVER}}', `ws://${req?.headers?.host || `${lanIp || '127.0.0.1'}:${wsPort}`}`);
		};
		const notifyDebounced = (level, text) => {
			const now = Date.now();
			if (now - state.lastNotifyAt < 30_000) return;
			state.lastNotifyAt = now;
			try { host.notify(level, text); } catch {}
		};

		// ── WS 汇聚 + CLI 下载（:wsPort，全网卡——主人设备经 WG 连入）──────────────
		const httpSrv = http.createServer((req, res) => {
			const url = new URL(req.url, 'http://local');
			if (url.pathname === '/cli') {
				res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8' });
				return res.end(cliCode(req));
			}
			if (url.pathname === '/status') {
				res.writeHead(200, { 'content-type': 'application/json' });
				return res.end(JSON.stringify(statusSnapshot()));
			}
			res.end('pi-tunnel plugin server\n');
		});
		const wss = new WebSocketServer({ noServer: true });
		httpSrv.on('upgrade', (req, sock, head) => {
			const url = new URL(req.url, 'http://local');
			if (url.pathname !== '/agent' || url.searchParams.get('token') !== token) {
				sock.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
				return sock.destroy();
			}
			wss.handleUpgrade(req, sock, head, ws => {
				const aid = `a${state.nextAid++}`;
				state.agents.set(aid, { ws, name: '', os: '', since: Date.now() });
				if (!agentById(state.activeAgentId)) state.activeAgentId = aid; // 无出口时首连即出口
				ws.on('message', raw => {
					let m; try { m = JSON.parse(raw.toString()); } catch { return; }
					const e = state.conns.get(m.id);
					switch (m.t) {
							case 'ping': { // 应用层心跳应答（CLI 25s 一发，服务端回 pong 供其判僵尸——TCP 半开时 onclose 不触发，靠这个自愈）
								const pa = state.agents.get(aid);
								if (pa) { try { pa.ws.send(JSON.stringify({ t: 'pong' })); } catch {} }
								break;
							}
							case 'hello': {
							const a = state.agents.get(aid);
							if (a) { a.name = String(m.name ?? ''); a.os = String(m.os ?? ''); a.ctrlPort = Number(m.ctrlPort) || 0; a.ver = String(m.ver || ''); }
							// 同名设备：能力优先（ctrlPort>0 的 P1 版保留）——旧版重连被拒长退避，根治互踢循环
							const twin = [...state.agents.entries()].find(([oid, oa]) => oid !== aid && oa.name && oa.name === a?.name && oa.ws.readyState === 1);
							if (twin) {
								const [oid, oa] = twin;
								const newFull = a.ctrlPort > 0 && !(oa.ctrlPort > 0); // 新连接有控制 API 而在线的没有 → 新版接管
								if (!newFull) {
									// 新连接是旧版（或在线的也是新版）：拒绝本次连接，令其长退避
									try { ws.send(JSON.stringify({ t: 'kicked', reason: '同名设备已有功能更全的实例在线' })); } catch {}
									try { ws.close(); } catch {}
									state.agents.delete(aid);
									break;
								}
								try { oa.ws.send(JSON.stringify({ t: 'kicked', by: aid })); } catch {}
								try { oa.ws.close(); } catch {}
								state.agents.delete(oid);
								for (const [cid2, e2] of state.conns) {
									if (e2.aid !== oid) continue;
									try { e2.c.destroy(); } catch {}
									state.conns.delete(cid2);
								}
							}
							try { notifyDebounced('info', `网络隧道：设备 ${a?.name || aid}（${a?.os || '未知系统'}）已就绪`); } catch {}
							if (!agentById(state.activeAgentId)) state.activeAgentId = aid;
							// 重连自动同步持久化配置（一次性标志，防 hello↔config 死循环：CLI 收 config 回 hello，server 又推 → 无限闪烁）
							if (devCfg[a.name] && !a.cfgSent) { a.cfgSent = true; toAgent(aid, { t: 'config', ...devCfg[a.name] }); }
							break;
						}
						case 'audit': { // C 档 P1：CLI 批量上报的操作审计
							const nm = state.agents.get(aid)?.name || aid;
							for (const it of (m.items ?? [])) {
								auditRing.push({ ts: it.ts, device: nm, op: it.op, detail: it.detail });
							}
							if (auditRing.length > 500) auditRing.splice(0, auditRing.length - 500);
							break;
						}
						case 'open':
							if (e && !e.replied) { e.replied = true; socksReply(e.c, 0); }
							break;
						case 'data': if (e) e.c.write(Buffer.from(m.b64, 'base64')); break;
						case 'end': if (e) e.c.end(); break;
						case 'err':
							if (e) auditRing.push({ ts: Date.now(), device: state.agents.get(aid)?.name || aid, op: 'socks.connect.fail', detail: String(m.msg || '').slice(0, 200) + ' → ' + (e.lastTarget ?? '') });
							if (e && !e.replied) { e.replied = true; socksReply(e.c, 5); }
							if (e) e.c.destroy();
							break;
						case 'close': if (e) { e.c.destroy(); state.conns.delete(m.id); } break;
						case 'ctrl-resp': { // P4: 设备控制响应回给等待中的面板请求
							const p = state.ctrlPending.get(m.rid);
							if (p) { state.ctrlPending.delete(m.rid); p.resolve({ status: m.status ?? 500, body: m.body ?? {} }); }
							break;
						}
					}
				});
				ws.on('close', () => {
					const a = state.agents.get(aid);
					const nm = a?.name || aid;
					state.agents.delete(aid);
					// 该设备承载的 SOCKS 连接全部拆除
					for (const [cid, e] of state.conns) {
						if (e.aid !== aid) continue;
						try { e.c.destroy(); } catch {}
						state.conns.delete(cid);
					}
					ensureActive();
					notifyDebounced('warning', `网络隧道：设备 ${nm} 已断开`);
				});
				ws.on('error', () => {});
			});
		});

		// ── SOCKS5（仅本机）───────────────────────────────────────────────────────
		const socksSrv = net.createServer(c => {
			c.on('error', () => {});
			let stage = 0;
			c.on('data', buf => {
				if (stage === 0) { // 阶段1: 方法协商（curl 分步收发不粘包，A 档实测成立）
					if (buf[0] !== 5) return c.destroy();
					c.write(Buffer.from([5, 0]));
					stage = 1;
					return;
				}
				c.removeAllListeners('data'); // 阶段2: CONNECT 请求
				const req = parseSocksConnect(buf);
				if (!req) { socksReply(c, 7); return c.destroy(); }
				const ag = activeAgent();
				console.log(`[tunnel] SOCKS CONNECT ${req.host}:${req.port} active=${state.activeAgentId} agentReady=${ag ? 1 : 0} agents=${state.agents.size}`);
				if (!ag) { socksReply(c, 5); return c.destroy(); } // 无在线设备：拒绝，AI 侧表现为快速失败
				const aid = state.activeAgentId;
				const cid = `c${state.nextId++}`;
				state.totalServed++;
				state.conns.set(cid, { c, replied: false, aid });
				c.on('data', d => toAgent(aid, { t: 'data', id: cid, b64: d.toString('base64') }));
				c.on('close', () => { state.conns.delete(cid); toAgent(aid, { t: 'close', id: cid }); });
				toAgent(aid, { t: 'connect', id: cid, host: req.host, port: req.port });
			});
		});

		// ── 服务启停（面板按钮 / POST /start /stop 控制；插件激活时默认启动）────────
		let running = false;
		async function startTunnel() {
			if (running) return true;
			const upWs = await listenSafe(httpSrv, wsPort, '0.0.0.0', `WS:${wsPort}`);
			const upSocks = await listenSafe(socksSrv, socksPort, '127.0.0.1', `SOCKS:${socksPort}`);
			running = upWs || upSocks;
			if (running) notifyDebounced('info', '网络隧道服务已启动');
			return running;
		}
		function stopTunnel() {
			if (!running) return;
			for (const [, e] of state.conns) { try { e.c.destroy(); } catch {} }
			state.conns.clear();
			for (const [, a] of state.agents) { try { a.ws.close(); } catch {} }
			state.agents.clear();
			state.activeAgentId = null;
			try { httpSrv.closeAllConnections?.(); } catch {}
			try { socksSrv.closeAllConnections?.(); } catch {}
			try { httpSrv.close(); } catch {}
			try { socksSrv.close(); } catch {}
			running = false;
			notifyDebounced('info', '网络隧道服务已停止');
		}

		// 端口被占时不拖垮宿主：error 后 notify 并继续
		const listenSafe = (srv, port, addr, name) => new Promise(resolve => {
			srv.once('error', e => {
				notifyDebounced('error', `pi-tunnel ${name} 启动失败：${e.code || e.message}`);
				resolve(false);
			});
			srv.listen(port, addr, () => resolve(true));
		});
		await startTunnel(); // 激活即运行，面板可随时停/启
		// 心跳 + 半开检测：ping 后未回 pong 的连接判定为僵尸（进程退出未挥手/网络半开），
		// terminate 触发 close → 从设备表移除（否则假在线残留，SOCKS 全部空响应，20261019 实战根因）
		const heartbeat = setInterval(() => {
			for (const [, a] of state.agents) {
				if (a.ws.readyState !== 1) continue;
				if (a.isAlive === false) {
					try { a.ws.terminate(); } catch {}
					continue;
				}
				a.isAlive = false;
				a.ws.ping();
				a.ws.once('pong', () => { a.isAlive = true; });
			}
		}, 30_000);

		// ── 宿主集成：route（面板数据 + CLI 下载 + 令牌轮换 + 出口切换 + 启停）───────
		const offStatus = host.route('GET', '/status', (_req, res) => {
			res.setHeader('content-type', 'application/json');
			res.end(JSON.stringify(statusSnapshot()));
		});
		const offCli = host.route('GET', '/cli', (req, res) => {
			res.setHeader('content-type', 'text/javascript; charset=utf-8');
			res.end(cliCode(req));
		});
		const _offPiPkg = host.route('GET', '/pi-pkg', (_req, res) => { // pi agent 离线安装包（mac 自包含 tgz，设备免公网 npm）
			try {
				const pkg = fs.readFileSync(path.join(__dirname, 'assets', 'pi-agent.tgz'));
				res.setHeader('content-type', 'application/gzip');
				res.setHeader('content-length', pkg.length);
				res.end(pkg);
			} catch { res.statusCode = 404; res.end('pi-agent.tgz not found'); }
		});
		const offRotate = host.route('POST', '/rotate', (_req, res) => {
			token = crypto.randomBytes(16).toString('hex');
			host.storage.set('token', token);
			res.setHeader('content-type', 'application/json');
			res.end(JSON.stringify({ ok: true, tokenPrefix: `${token.slice(0, 4)}…`, hint: '令牌已重置：所有设备需重新下载 CLI' }));
			notifyDebounced('info', '网络隧道：令牌已重置，所有设备 CLI 需重新下载');
		});
		const offStart = host.route('POST', '/start', async (_req, res) => {
			const ok = await startTunnel();
			res.setHeader('content-type', 'application/json');
			res.end(JSON.stringify({ ok, running }));
		});
		const offStop = host.route('POST', '/stop', (_req, res) => {
			stopTunnel();
			res.setHeader('content-type', 'application/json');
			res.end(JSON.stringify({ ok: true, running }));
		});
		const offSelect = host.route('POST', '/agent/select', (req, res) => {
			let body = '';
			req.on('data', ch => { body += ch; });
			req.on('end', () => {
				let id = '';
				try { id = String(JSON.parse(body || '{}').id ?? ''); } catch {}
				if (!agentById(id)) {
					res.setHeader('content-type', 'application/json');
					return res.end(JSON.stringify({ ok: false, error: '设备不在线' }));
				}
				state.activeAgentId = id;
				const nm = state.agents.get(id)?.name || id;
				notifyDebounced('info', `网络隧道：出口已切换到 ${nm}`);
				res.setHeader('content-type', 'application/json');
				res.end(JSON.stringify({ ok: true, activeAgentId: id }));
			});
		});

		// C 档 P1：设备能力/白名单下发（CLI 持久化并回 hello 确认）+ 审计查询
		const offConfig = host.route('POST', '/agent/config', async (req, res) => {
			{
				const j = await readBodyJson(req);
				let id = '', patch = {}, name = '';
				id = String(j.id ?? ''); patch = j; name = String(j.name || '');
				const a = state.agents.get(id);
				const nm = a?.name || name; // 离线预配置：设备 crash/不在线时可直接传 name 持久化，重连自动下发（防 fsWrite 死锁）
				res.setHeader('content-type', 'application/json');
				if (!nm) return res.end(JSON.stringify({ ok: false, error: '设备不在线且未提供 name' }));
				const cur = capsOf(nm);
				const next = {
					fsRead: typeof patch.fsRead === 'boolean' ? patch.fsRead : (cur.fsRead ?? true),
					fsWrite: typeof patch.fsWrite === 'boolean' ? patch.fsWrite : (cur.fsWrite ?? false),
					whitelist: Array.isArray(patch.whitelist) && patch.whitelist.length ? patch.whitelist : (cur.whitelist ?? ['~/Downloads']),
				};
				devCfg[nm] = next;
				saveDevCfg();
				if (a) toAgent(id, { t: 'config', ...next });
				try { host.notify('info', `网络隧道：设备 ${nm} 配置已更新（fsWrite=${next.fsWrite}${a ? '' : '，待设备上线生效'}）`); } catch {}
				res.end(JSON.stringify({ ok: true, name: nm, config: next, pending: !a }));
			}
		});
			const _offDeviceFs = host.route('POST', '/device/fs', async (req, res) => { // P4: 面板浏览设备目录（选白名单路径用）
				{
					const j = await readBodyJson(req);
					const id = String(j.id ?? ''), p = String(j.path || '~');
					const d = id ? await deviceCtrl(id, '/fs/browse?path=' + encodeURIComponent(p)) : { status: 400, body: { error: '缺少设备 id' } };
					res.setHeader('content-type', 'application/json');
					res.end(JSON.stringify(d.body));
				}
			});
			const _offUninstall = host.route('POST', '/device/uninstall', async (req, res) => { // P4: 面板下发 CLI 自卸载
				{
					const j = await readBodyJson(req);
					const id = String(j.id ?? '');
					const a = state.agents.get(id);
					res.setHeader('content-type', 'application/json');
					if (!a) return res.end(JSON.stringify({ ok: false, error: '设备不在线' }));
					toAgent(id, { t: 'uninstall' });
					try { host.notify('warning', `网络隧道：已下发卸载指令到 ${a.name || id}（停常驻+删文件）`); } catch {}
					res.end(JSON.stringify({ ok: true }));
				}
			});
			const _offHw = host.route('POST', '/device/hw', async (req, res) => { // P4+: 查看设备硬件概览（只读）
				{
					const j = await readBodyJson(req);
					const id = String(j.id ?? '');
					const d = id ? await deviceCtrl(id, '/sys/hw') : { status: 400, body: { error: '缺少设备 id' } };
					res.setHeader('content-type', 'application/json');
					res.end(JSON.stringify(d.body));
				}
			});
			const _offTask = host.route('POST', '/device/task', async (req, res) => { // P4-B: 通用任务通道（指挥设备 pi agent）
				{
					const j = await readBodyJson(req);
					const id = String(j.id ?? '');
					const me = resolveModelEnv();
					if (!me) {
						res.setHeader('content-type', 'application/json');
						return res.end(JSON.stringify({ error: '模型通道无法解析（未找到当前会话模型或网关 key）——可在面板设置手动配置 modelEnv' }));
					}
					const payload = JSON.stringify({ prompt: String(j.prompt ?? ''), tools: String(j.tools || 'read,grep,glob'), env: me.env, model: me.model, timeoutS: +j.timeoutS || 300 });
					console.log(`[tunnel] task → ${id} model=${me.model} baseUrl=${me.env.OPENAI_BASE_URL || '-'} promptLen=${payload.length}`);
					const d = id ? await deviceCtrl(id, '/task', { method: 'POST', body: payload }, (+j.timeoutS || 300) * 1000 + 30000) : { status: 400, body: { error: '缺少设备 id' } };
					res.setHeader('content-type', 'application/json');
					res.end(JSON.stringify(d.body));
				}
			});
			const offAudit = host.route('GET', '/audit', (_req, res) => {
			res.setHeader('content-type', 'application/json');
			res.end(JSON.stringify({ items: auditRing.slice(-100).reverse() }));
		});

		// ── 宿主集成：AI 工具（数据面 = 当前出口设备所在网络）──────────────────────
		const offTool = host.registerAgentTool({
			name: 'tunnel_fetch',
			label: '隧道探测',
			description:
				'经「主人设备反向隧道」发 HTTP 请求：数据面在出口设备所在网络执行，DNS 也在出口设备侧解析。' +
				'用于巡检主人网络（出口 IP、内网设备端口、经主人网络访问外网）。' +
				'无在线设备时快速失败。多设备时走面板选中的出口设备。' +
				'示例: tunnel_fetch {url:"http://myip.ipip.net"} 返回出口设备网络的出口 IP。',
			parameters: {
				type: 'object',
				properties: {
					url: { type: 'string', description: '目标 URL（http/https），域名由出口设备侧解析' },
					timeout: { type: 'number', description: '超时秒数，默认 20，范围 3-60' },
				},
				required: ['url'],
			},
			execute: async (_toolCallId, params) => {
				const url = String(params.url ?? '');
				if (!/^https?:\/\//.test(url)) return { ok: false, error: 'url 需以 http(s):// 开头' };
				const timeout = Math.min(Math.max(Number(params.timeout ?? 20), 3), 60);
				const args = [
					'--socks5-hostname', `127.0.0.1:${socksPort}`,
					'--max-time', String(timeout), '-s',
					'-w', '\n__META__ %{http_code} %{time_total}s',
					url,
				];
				return new Promise(resolve => {
					execFile('curl', args, { timeout: (timeout + 5) * 1000, maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => {
						const offline = !activeAgent();
						if (err && !stdout) {
							return resolve({ ok: false, agentOnline: !offline, error: String(err.code || err.message), hint: offline ? '无在线出口设备，隧道不可用' : undefined });
						}
						const [body, meta] = String(stdout).split('\n__META__ ');
						resolve({ ok: !err, agentOnline: !offline, via: state.agents.get(state.activeAgentId)?.name || state.activeAgentId, http: (meta || '').trim(), body: body.slice(0, 8000) });
					});
				});
			},
		});

		if (running) {
			notifyDebounced('info', '网络隧道插件已就绪（多设备模式）');
		}

		// deactivate 清理（宿主 reload/停用时调用）
		return () => {
			clearInterval(heartbeat);
			offStatus(); offCli(); offRotate(); offStart(); offStop(); offSelect(); offConfig(); offAudit(); offTool();
			stopTunnel();
			try { wss.close(); } catch {}
		};
	},
};
