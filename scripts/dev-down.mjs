#!/usr/bin/env node
'use strict';
//
// 停止 NodeBB（用于 Ctrl+C 未能正常收尾、或在另一个终端里手动收尾的场景）。
// mock 服务是 `npm run dev` 的直接子进程，随该终端 Ctrl+C 一起退出；
// 若那个终端被强制关闭而不是 Ctrl+C，请自行在系统任务管理器/活动监视器中结束
// 残留的 `node mocks/.../server.js` 进程。
//
// 用法：npm run dev:stop
//
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { run, checkTcpPort } from './lib/proc.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const NBB = path.join(ROOT, 'nodebb');
const NODEBB_CLI = path.join(NBB, 'nodebb');

async function main() {
	try {
		run(process.execPath, [NODEBB_CLI, 'stop'], { cwd: NBB });
	} catch (e) {
		console.error('[dev:stop] 调用 nodebb stop 出错:', e.message);
	}
	await new Promise(r => setTimeout(r, 800));
	if (await checkTcpPort('127.0.0.1', 4567, 300)) {
		console.warn('[dev:stop] 警告：端口 4567 仍被占用，请检查是否有残留的 node 进程需要手动结束。');
	} else {
		console.log('[dev:stop] NodeBB 已停止。');
	}
}

main();
