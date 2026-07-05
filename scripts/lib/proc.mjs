'use strict';
// 跨平台进程/命令小工具（Windows / macOS / Linux 通用）。
// 原则：能不经过 shell 就不经过 —— 直接调用真实可执行文件（node/git/docker 的 .exe），
// 避免 Windows cmd.exe 的引号转义问题；仅 npm 需要按平台选择 npm.cmd。

import { spawn, spawnSync } from 'node:child_process';
import net from 'node:net';

export function npmCmd() {
	return process.platform === 'win32' ? 'npm.cmd' : 'npm';
}

// 同步执行一个命令，失败即抛出（用于安装类关键步骤）。
export function run(cmd, args, opts = {}) {
	const res = spawnSync(cmd, args, { stdio: 'inherit', ...opts });
	if (res.error) { throw res.error; }
	if (res.status !== 0) {
		throw new Error(`命令失败 (exit ${res.status}): ${cmd} ${args.join(' ')}`);
	}
	return res;
}

// 用当前 node 可执行文件运行一个脚本/CLI 文件（如 NodeBB 的 `nodebb` 文件本身）。
// 用 process.execPath 而非 "node" 字符串，避免 PATH 查找差异；不经 shell，天然跨平台安全。
export function runNode(scriptFile, args = [], opts = {}) {
	return run(process.execPath, [scriptFile, ...args], opts);
}

// 静默尝试执行一个命令，只返回是否成功（用于探测 docker 是否可用等）。
export function tryRun(cmd, args, opts = {}) {
	const res = spawnSync(cmd, args, { stdio: 'ignore', ...opts });
	return !res.error && res.status === 0;
}

// 探测 TCP 端口是否已监听（用于等待 Postgres / mock 服务就绪）。
export function checkTcpPort(host, port, timeout = 1500) {
	return new Promise((resolve) => {
		const socket = new net.Socket();
		const done = (ok) => { socket.destroy(); resolve(ok); };
		socket.setTimeout(timeout);
		socket.once('connect', () => done(true));
		socket.once('timeout', () => done(false));
		socket.once('error', () => done(false));
		socket.connect(port, host);
	});
}

export async function waitForTcpPort(host, port, { retries = 30, intervalMs = 1000, label } = {}) {
	for (let i = 0; i < retries; i += 1) {
		// eslint-disable-next-line no-await-in-loop
		if (await checkTcpPort(host, port)) { return true; }
		if (i === 0) { console.log(`   等待 ${label || `${host}:${port}`} 就绪...`); }
		// eslint-disable-next-line no-await-in-loop
		await new Promise(r => setTimeout(r, intervalMs));
	}
	return false;
}

// 启动一个长驻子进程（继承 stdio，方便 dev-up 场景在同一个终端看到日志）。
export function spawnLong(cmd, args, opts = {}) {
	return spawn(cmd, args, { stdio: 'inherit', ...opts });
}
