#!/usr/bin/env node
'use strict';
//
// 启动全部服务：PostgreSQL（若未运行则用 docker compose 拉起）+ mock SSO + mock IM + NodeBB。
// 纯 Node.js 实现，Windows / macOS / Linux 通用。
//
// NodeBB 生命周期用官方 `start`/`stop`（内部daemon 化基于 child_process.spawn+detach，
// 不是 Unix-only 的 setsid/fork，Windows 上同样可用），并写 pidfile，
// 比“前台子进程 + 逐级转发信号”更可靠地保证 Ctrl+C 能干净收尾。
// mock 服务作为本脚本的直接子进程运行（继承 stdio），Ctrl+C 时随本脚本一起退出。
//
// 用法：npm run dev   （Ctrl+C 停止全部服务）
//
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { run, spawnLong, checkTcpPort } from './lib/proc.mjs';
import { ensurePostgresUp } from './lib/postgres.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const NBB = path.join(ROOT, 'nodebb');
const NODEBB_CLI = path.join(NBB, 'nodebb');

const children = [];
let shuttingDown = false;

function launch(name, cmd, args, opts = {}) {
	const child = spawnLong(cmd, args, opts);
	children.push({ name, child });
	child.on('exit', (code, signal) => {
		if (shuttingDown) { return; }
		console.log(`\n[dev] ${name} 已退出 (code=${code}, signal=${signal})，正在关闭其它服务...`);
		shutdown(code || 0);
	});
	return child;
}

function stopNodebb() {
	try {
		run(process.execPath, [NODEBB_CLI, 'stop'], { cwd: NBB });
	} catch (e) {
		console.error('[dev] 停止 NodeBB 时出错（可能本来就未运行）:', e.message);
	}
}

async function shutdown(code = 0) {
	if (shuttingDown) { return; }
	shuttingDown = true;
	console.log('\n[dev] 正在停止全部服务...');
	for (const { child } of children) {
		if (!child.killed) { try { child.kill(); } catch { /* noop */ } }
	}
	stopNodebb();

	// Windows 上跨进程 SIGTERM 会被当作强制终止处理，可能来不及让 NodeBB 优雅退出、
	// 释放端口；这里额外探测一次并给出可操作的手动提示，而不是静默假装已经收尾干净。
	await new Promise(r => setTimeout(r, 800));
	if (await checkTcpPort('127.0.0.1', 4567, 300)) {
		console.warn('[dev] 警告：端口 4567 似乎仍被占用。若 NodeBB 未能自行退出，请手动执行：');
		console.warn(`      ${process.execPath} "${NODEBB_CLI}" stop`);
	}
	process.exit(code);
}

process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));

async function main() {
	console.log('==> PostgreSQL');
	await ensurePostgresUp(ROOT);

	console.log('==> mock SSO (App 后端) :5555');
	launch('mock-sso', process.execPath, [path.join(ROOT, 'mocks/sso/server.js')]);

	console.log('==> mock IM (团队机器人中转) :5566');
	launch('mock-im', process.execPath, [path.join(ROOT, 'mocks/im/server.js')]);

	console.log('==> NodeBB :4567');
	run(process.execPath, [NODEBB_CLI, 'start'], { cwd: NBB });

	console.log('');
	console.log('论坛：      http://localhost:4567');
	console.log('mock SSO：  http://127.0.0.1:5555/_users');
	console.log('mock IM：   http://127.0.0.1:5566/im/received');
	console.log('NodeBB 日志文件： nodebb/logs/output.log');
	console.log('（按 Ctrl+C 可同时停止全部服务）');
}

main().catch((e) => { console.error('[dev] 启动失败:', e.message || e); shutdown(1); });
