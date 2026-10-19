/**
 * pi-tunnel 插件面板 —— 隧道状态(三态) / 出口设备管理(多设备) / 服务启停 / 令牌 / 三平台常驻化。
 * 数据源：GET /plugins-api/tunnel/status（3s 轮询）；操作：POST start/stop/rotate/agent/select。
 * 可重入：mount 返回清理函数，plugins_reload 后由宿主重新 mount。
 * HTML 拼接用字符串相加而非嵌套模板串（20261019 嵌套模板曾触发 V8 解析错，规避）。
 */
import { defineView } from './sdk/index.mjs';

const CSS = `
.tnl-wrap { font-family: -apple-system, "PingFang SC", sans-serif; font-size: 13px; line-height: 1.7; max-width: 720px; padding: 16px; color: var(--text, inherit); }
.tnl-card { border: 1px solid var(--border, var(--border-soft, #8884)); border-radius: 10px; padding: 14px 16px; margin-bottom: 12px; background: var(--bg-elev, var(--bg, transparent)); }
.tnl-row { display: flex; align-items: center; gap: 10px; margin: 5px 0; flex-wrap: wrap; }
.tnl-dot { width: 11px; height: 11px; border-radius: 50%; background: var(--text-faint, #999); flex: none; }
.tnl-dot.ok { background: var(--green, #34c759); box-shadow: 0 0 0 3px var(--green-soft, #34c75933); }
.tnl-dot.bad { background: var(--red, #ff3b30); box-shadow: 0 0 0 3px var(--red-soft, #ff3b3033); }
.tnl-state { font-size: 15px; font-weight: 700; color: var(--text-strong, var(--text, inherit)); }
.tnl-label { color: var(--text-dim, #999); min-width: 92px; flex: none; }
.tnl-mono { font-family: var(--mono, ui-monospace, Menlo, monospace); }
.tnl-token { font-family: var(--mono, ui-monospace, Menlo, monospace); color: var(--amber-text, var(--text)); background: var(--accent-soft, #8881); border-radius: 5px; padding: 1px 8px; }
.tnl-btn { border: 1px solid var(--border, #8886); border-radius: 6px; padding: 3px 14px; cursor: pointer; background: transparent; color: var(--text, inherit); font-size: 12px; }
.tnl-btn:hover { background: var(--accent-soft, #8882); }
.tnl-btn.danger { color: var(--red-text, var(--red)); border-color: var(--red, #d33); }
.tnl-btn.danger:hover { background: var(--red-soft, #d3322); }
.tnl-btn.primary { color: var(--accent-contrast, #fff); background: var(--accent, #4a7dff); border-color: var(--accent, #4a7dff); }
.tnl-btn.primary:hover { filter: brightness(1.1); }
.tnl-btn.tab.on { background: var(--accent-soft, #8882); border-color: var(--accent, #4a7dff); color: var(--text-strong, var(--text)); }
.tnl-code { font-family: var(--mono, ui-monospace, Menlo, monospace); font-size: 11.5px; background: var(--bg-elev2, #8881); border: 1px solid var(--border-soft, #8883); border-radius: 6px; padding: 8px 10px; overflow-x: auto; white-space: pre; color: var(--text); }
.tnl-a { color: var(--link, var(--accent)); }
.tnl-a:hover { color: var(--link-hover, var(--accent)); }
.tnl-dim { color: var(--text-faint, #999); }
.tnl-copied { color: var(--green, #34c759); }
`;

let lastLanIp = ''; // 由 status 轮询填充；无内网 IP 时命令里用占位符提示替换
let lastPort = 8765;

/** 三平台常驻安装命令（CLI 已在用户主目录：~/pi-tunnel-cli.mjs / %USERPROFILE%\pi-tunnel-cli.mjs）。 */
function persistCmd(os) {
	const host = lastLanIp || '<mini内网IP>';
	const port = lastPort || 8765;
	if (os === 'Windows') {
		return [
			'curl.exe -o $env:USERPROFILE\\pi-tunnel-cli.mjs http://' + host + ':' + port + '/cli',
			'schtasks /create /tn "pi-tunnel" /tr "node $env:USERPROFILE\\pi-tunnel-cli.mjs" /sc onlogon /f',
			'schtasks /run /tn "pi-tunnel"',
			'echo 常驻已装：登录自启，CLI 内置 5s 掉线重连',
		].join('\n');
	}
	if (os === 'Linux') {
		return [
			'curl -o ~/pi-tunnel-cli.mjs http://' + host + ':' + port + '/cli',
			'mkdir -p ~/.config/systemd/user',
			'cat > ~/.config/systemd/user/pi-tunnel.service <<UNIT',
			'[Unit]',
			'Description=pi-tunnel CLI',
			'[Service]',
			'ExecStart=/usr/bin/env node %h/pi-tunnel-cli.mjs',
			'Restart=always',
			'RestartSec=5',
			'[Install]',
			'WantedBy=default.target',
			'UNIT',
			'systemctl --user daemon-reload',
			'systemctl --user enable --now pi-tunnel',
			'echo 常驻已装：开机自启+掉线自愈',
		].join('\n');
	}
	// macOS（默认）
	return [
		'curl -o ~/pi-tunnel-cli.mjs http://' + host + ':' + port + '/cli',
		'NODE_BIN=$(command -v node)',
		'mkdir -p ~/Library/LaunchAgents',
		'launchctl bootout gui/$(id -u)/com.pi-tunnel.cli 2>/dev/null',
		'cat > ~/Library/LaunchAgents/com.pi-tunnel.cli.plist <<PLIST',
		'<?xml version="1.0" encoding="UTF-8"?>',
		'<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
		'<plist version="1.0">',
		'<dict>',
		'  <key>Label</key><string>com.pi-tunnel.cli</string>',
		'  <key>ProgramArguments</key>',
		'  <array>',
		'    <string>$NODE_BIN</string>',
		'    <string>$HOME/pi-tunnel-cli.mjs</string>',
		'  </array>',
		'  <key>RunAtLoad</key><true/>',
		'  <key>KeepAlive</key><true/>',
		'  <key>StandardOutPath</key><string>/tmp/pi-tunnel-cli.log</string>',
		'  <key>StandardErrorPath</key><string>/tmp/pi-tunnel-cli.log</string>',
		'</dict>',
		'</plist>',
		'PLIST',
		'launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.pi-tunnel.cli.plist',
		'echo 常驻已装：开机自启+掉线自愈',
	].join('\n');
}

function esc(s) {
	return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

export default defineView({
	mount(el) {
		const style = document.createElement('style');
		style.textContent = CSS;
		el.appendChild(style);
		const H = [
			'<div class="tnl-wrap">',
			'<div class="tnl-card">',
			'<div class="tnl-row"><span class="tnl-dot" id="tnl-dot"></span><span class="tnl-state" id="tnl-state">读取中…</span>',
			'<button class="tnl-btn danger" id="tnl-toggle">停止服务</button></div>',
			'<div class="tnl-row"><span class="tnl-label">连接数</span><span id="tnl-conns">—</span></div>',
			'<div class="tnl-row"><span class="tnl-label">端口</span><span class="tnl-mono" id="tnl-ports">—</span></div>',
			'</div>',
			'<div class="tnl-card">',
			'<div class="tnl-row"><b>出口设备</b><span class="tnl-dim">SOCKS 流量走选中的设备；出口掉线自动切换</span></div>',
			'<div id="tnl-devs"><div class="tnl-row tnl-dim">加载中…</div></div>',
			'</div>',
			'<div class="tnl-card">',
			'<div class="tnl-row"><span class="tnl-label">接入令牌</span><span class="tnl-token" id="tnl-token">—</span>',
			'<button class="tnl-btn danger" id="tnl-rotate">重置令牌</button></div>',
			'<div class="tnl-row tnl-dim">重置后所有已分发 CLI 将无法重连，需重新下载。</div>',
			'</div>',
			'<div class="tnl-card">',
			'<div class="tnl-row"><b>设备常驻化（一次性，装完不开终端；按设备系统选页签）</b></div>',
			'<div class="tnl-row" id="tnl-tabs">',
			'<button class="tnl-btn tab on" data-os="macOS">macOS</button>',
			'<button class="tnl-btn tab" data-os="Windows">Windows</button>',
			'<button class="tnl-btn tab" data-os="Linux">Linux</button>',
			'</div>',
			'<div class="tnl-code" id="tnl-persist"></div>',
			'<div class="tnl-row" style="margin-top:8px">',
			'<button class="tnl-btn primary" id="tnl-copy">复制当前页签命令</button>',
			'<span class="tnl-copied" id="tnl-copy-ok" style="display:none">已复制</span>',
			'<a class="tnl-a" id="tnl-dl" href="/plugins-api/tunnel/cli" download="pi-tunnel-cli.mjs">下载 CLI（已注入令牌）</a>',
			'</div>',
			'<div class="tnl-row tnl-dim">AI 侧探测： curl --socks5-hostname 127.0.0.1:1080 &lt;url&gt;</div>',
			'</div>',
			'</div>',
		].join('\n');
		el.insertAdjacentHTML('beforeend', H);
		const $ = s => el.querySelector(s);
		let running = null;
		let curOs = 'macOS';

		// 页签切换
		$('#tnl-tabs').addEventListener('click', e => {
			const b = e.target.closest('button.tab');
			if (!b) return;
			curOs = b.dataset.os;
			const tabs = $('#tnl-tabs').querySelectorAll('button.tab');
			for (const x of tabs) x.classList.toggle('on', x === b);
			$('#tnl-persist').textContent = persistCmd(curOs);
		});
		$('#tnl-persist').textContent = persistCmd(curOs);

		// 出口设备切换（事件委托）
		$('#tnl-devs').addEventListener('click', async e => {
			const b = e.target.closest('button[data-id]');
			if (!b) return;
			try { await fetch('/plugins-api/tunnel/agent/select', { method: 'POST', body: JSON.stringify({ id: b.dataset.id }) }); } catch {}
			refresh();
		});

		function renderDevs(d) {
			const dv = $('#tnl-devs');
			const list = d.devices ?? [];
			if (!list.length) {
				dv.innerHTML = '<div class="tnl-row tnl-dim">暂无设备连入——在主人设备上运行 CLI 后出现在这里</div>';
				return;
			}
			dv.innerHTML = list.map(x => {
				const dot = '<span class="tnl-dot ' + (x.online ? 'ok' : '') + '"></span>';
				const nm = '<span class="tnl-mono">' + esc(x.name) + '</span>';
				const osf = '<span class="tnl-dim">' + esc(x.os || '—') + '</span>';
				let tag;
				if (x.id === d.activeAgentId) tag = '<span class="tnl-token">当前出口</span>';
				else if (x.online) tag = '<button class="tnl-btn" data-id="' + esc(x.id) + '">设为出口</button>';
				else tag = '<span class="tnl-dim">重连中</span>';
				return '<div class="tnl-row">' + dot + nm + osf + tag + '</div>';
			}).join('');
		}

		async function refresh() {
			try {
				const r = await fetch('/plugins-api/tunnel/status');
				const d = await r.json();
				running = d.running;
				const dot = $('#tnl-dot'), st = $('#tnl-state'), btn = $('#tnl-toggle');
				const act = (d.devices ?? []).find(x => x.id === d.activeAgentId);
				dot.className = 'tnl-dot ' + (d.agentOnline ? 'ok' : (d.running ? 'bad' : ''));
				st.textContent = d.agentOnline ? ('隧道在线 · 出口 ' + (act ? act.name : ''))
					: (d.running ? '服务运行 · 等待设备连入' : '服务已停止');
				btn.textContent = d.running ? '停止服务' : '启动服务';
				btn.className = 'tnl-btn ' + (d.running ? 'danger' : 'primary');
				$('#tnl-conns').textContent = '活跃 ' + d.activeConns + ' · 累计 ' + d.totalServed;
				$('#tnl-token').textContent = d.tokenPrefix;
				$('#tnl-ports').textContent = 'WS :' + d.wsPort + ' · SOCKS5 127.0.0.1:' + d.socksPort;
				lastLanIp = d.lanIp || '';
				lastPort = d.wsPort || 8765;
				$('#tnl-persist').textContent = persistCmd(curOs); // lanIp/port 到位后刷新命令
				renderDevs(d);
			} catch {
				$('#tnl-state').textContent = '状态读取失败（插件未激活？）';
			}
		}
		refresh();
		const timer = setInterval(refresh, 3000);

		$('#tnl-toggle').onclick = async () => {
			const ep = running ? '/plugins-api/tunnel/stop' : '/plugins-api/tunnel/start';
			try { await fetch(ep, { method: 'POST' }); } catch {}
			refresh();
		};
		$('#tnl-rotate').onclick = async () => {
			if (!confirm('重置令牌后，所有已分发 CLI 将无法重连（需重新下载）。确定重置？')) return;
			try { await fetch('/plugins-api/tunnel/rotate', { method: 'POST' }); } catch {}
			refresh();
		};
		$('#tnl-copy').onclick = async () => {
			try {
				await navigator.clipboard.writeText(persistCmd(curOs));
				const ok = $('#tnl-copy-ok');
				ok.style.display = 'inline';
				setTimeout(() => { ok.style.display = 'none'; }, 2000);
			} catch {
				alert('复制失败：请手动选中命令块复制');
			}
		};

		return () => clearInterval(timer);
	},
});
