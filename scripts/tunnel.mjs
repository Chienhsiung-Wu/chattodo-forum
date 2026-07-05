#!/usr/bin/env node
'use strict';
//
// 通过 Cloudflare 快速隧道（quick tunnel）把本地论坛 http://localhost:4567 反代到外网。
// 零配置、无需 Cloudflare 账号/域名：每次启动分配一个随机 *.trycloudflare.com 地址。
//
// 关键点：NodeBB 用 config.json 的 `url` 生成绝对链接 / socket.io 连接地址 / CSRF 校验，
// 所以本脚本会在隧道起来后，把 `url` 临时改成公网地址并重启 NodeBB；Ctrl+C 退出时
// 自动改回 http://localhost:4567 并重启，保证本地环境不被污染。
//
// 前置：先 `npm run dev` 让论坛在 4567 跑起来；再另开一个终端 `npm run tunnel`。
// 用法：npm run tunnel   （Ctrl+C 停止隧道并还原本地 url）
//
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { run, checkTcpPort } from './lib/proc.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const NBB = path.join(ROOT, 'nodebb');
const NODEBB_CLI = path.join(NBB, 'nodebb');
const CONFIG = path.join(NBB, 'config.json');
const LOCAL_PORT = 4567;
const LOCAL_URL = `http://localhost:${LOCAL_PORT}`;

// 定位 cloudflared 可执行文件：环境变量 > 用户目录下的 portable 副本 > PATH。
function resolveCloudflared() {
	if (process.env.CLOUDFLARED_BIN && fs.existsSync(process.env.CLOUDFLARED_BIN)) {
		return process.env.CLOUDFLARED_BIN;
	}
	const exe = process.platform === 'win32' ? 'cloudflared.exe' : 'cloudflared';
	const portable = path.join(os.homedir(), 'cloudflared', exe);
	if (fs.existsSync(portable)) { return portable; }
	return 'cloudflared'; // 交给 PATH 解析
}

function readConfig() {
	return JSON.parse(fs.readFileSync(CONFIG, 'utf8'));
}

function setNodebbUrl(url) {
	const cfg = readConfig();
	cfg.url = url;
	fs.writeFileSync(CONFIG, `${JSON.stringify(cfg, null, 4)}\n`);
}

function restartNodebb() {
	run(process.execPath, [NODEBB_CLI, 'restart'], { cwd: NBB });
}

let cf = null;
let shuttingDown = false;

async function shutdown(code = 0) {
	if (shuttingDown) { return; }
	shuttingDown = true;
	console.log('\n[tunnel] 正在关闭隧道并还原本地 url...');
	if (cf && !cf.killed) { try { cf.kill(); } catch { /* noop */ } }
	try {
		const cfg = readConfig();
		if (cfg.url !== LOCAL_URL) {
			setNodebbUrl(LOCAL_URL);
			console.log(`[tunnel] config.url 已还原为 ${LOCAL_URL}，重启 NodeBB 使其生效...`);
			restartNodebb();
		}
	} catch (e) {
		console.error('[tunnel] 还原 url 时出错，请手动核对 nodebb/config.json:', e.message);
	}
	process.exit(code);
}

process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));

async function main() {
	// 1) 确认本地论坛在跑，否则隧道反代的是空端口。
	if (!(await checkTcpPort('127.0.0.1', LOCAL_PORT))) {
		console.error(`[tunnel] 本地 ${LOCAL_URL} 未监听。请先在另一个终端运行 npm run dev，再启动隧道。`);
		process.exit(1);
	}

	const bin = resolveCloudflared();
	// cloudflared 默认走 QUIC（UDP 7844），很多公司网络/代理会挡 UDP，表现为
	// "failed to dial to edge with quic: timeout"。默认改用 http2（走 TCP 443）更易穿透；
	// 可用 CF_PROTOCOL=quic 覆盖回默认。
	const protocol = process.env.CF_PROTOCOL || 'http2';
	console.log(`==> 启动 Cloudflare 快速隧道 → ${LOCAL_URL}`);
	console.log(`   cloudflared: ${bin}  (protocol=${protocol})`);

	// 2) 起 quick tunnel。cloudflared 把分配的 URL 打到 stderr。
	cf = spawn(bin, ['tunnel', '--no-autoupdate', '--protocol', protocol, '--url', LOCAL_URL], {
		stdio: ['ignore', 'pipe', 'pipe'],
	});

	let applied = false;
	// 只认真正分配的随机子域名，排除 api.trycloudflare.com（那是申请隧道的 API 端点，
	// 会出现在报错信息里，不是可访问地址）。
	const urlRe = /(https:\/\/[a-z0-9-]+\.trycloudflare\.com)/i;

	const onData = (buf) => {
		const text = buf.toString();
		process.stdout.write(text.split('\n').filter(Boolean).map(l => `   [cf] ${l}`).join('\n') + '\n');
		if (applied) { return; }
		// 申请隧道失败（常见于本机 VPN/代理拦截了到 Cloudflare 的连接）：明确报错而非假装成功。
		if (/failed to request quick Tunnel|failed to dial to edge/i.test(text)) {
			console.error('\n[tunnel] 无法连上 Cloudflare 边缘（申请隧道失败）。');
			console.error('  常见原因：本机 VPN/代理（Clash/Surge 等）拦截了到 *.trycloudflare.com 的连接，');
			console.error('  或公司网络封锁了相关端口。请临时关闭代理/VPN，或让其对 trycloudflare.com 走直连后重试。');
			console.error('  也可试 CF_PROTOCOL=quic npm run tunnel 切换协议。');
			shutdown(1);
			return;
		}
		const m = text.match(urlRe);
		if (!m || m[1].includes('//api.trycloudflare.com')) { return; }
		applied = true;
		const publicUrl = m[1];
		// 3) 把公网地址写进 NodeBB config 并重启，让 socket.io / 绝对链接指向隧道。
		console.log(`\n==> 已分配公网地址：${publicUrl}`);
		console.log('==> 写入 NodeBB config.url 并重启（约 20~30 秒生效）...');
		try {
			setNodebbUrl(publicUrl);
			restartNodebb();
			console.log('');
			console.log('==================================================================');
			console.log(`  ✅ 论坛已反代到外网：  ${publicUrl}`);
			console.log(`     本地仍可访问：      ${LOCAL_URL}`);
			console.log('     外网用户可浏览首页/版块/种子帖（只读试用）。');
			console.log('     Ctrl+C 停止隧道并自动把 url 还原为 localhost。');
			console.log('==================================================================');
		} catch (e) {
			console.error('[tunnel] 应用公网 url 失败:', e.message);
			shutdown(1);
		}
	};

	cf.stdout.on('data', onData);
	cf.stderr.on('data', onData);
	cf.on('exit', (code, signal) => {
		if (shuttingDown) { return; }
		console.log(`\n[tunnel] cloudflared 已退出 (code=${code}, signal=${signal})。`);
		shutdown(code || 0);
	});
}

main().catch((e) => { console.error('[tunnel] 启动失败:', e.message || e); shutdown(1); });
