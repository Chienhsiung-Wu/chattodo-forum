'use strict';
// 确保 PostgreSQL 可用：优先复用已在运行的实例（原生安装/已起的容器/CI 服务容器），
// 否则在 docker 可用时用仓库根目录的 docker-compose.yml 拉起；否则给出明确的手动指引。
// 全程不依赖 pg_ctlcluster / su postgres 等 Linux 专有命令，Windows/macOS/Linux 通用。

import { tryRun, run, checkTcpPort, waitForTcpPort } from './proc.mjs';

export const PGHOST = process.env.PGHOST || '127.0.0.1';
export const PGPORT = parseInt(process.env.PGPORT || '5432', 10);
export const DBNAME = process.env.DBNAME || 'nodebb';
export const DBUSER = process.env.DBUSER || 'nodebb';
export const DBPASS = process.env.DBPASS || 'nodebb';

export async function ensurePostgresUp(root) {
	if (await checkTcpPort(PGHOST, PGPORT)) {
		console.log(`   PostgreSQL 已在 ${PGHOST}:${PGPORT} 就绪（复用现有实例）`);
		return;
	}

	const dockerAvailable = tryRun('docker', ['--version']);
	if (!dockerAvailable) {
		throw new Error(
			`未探测到 ${PGHOST}:${PGPORT} 上的 PostgreSQL，且未安装 Docker。\n` +
			'请二选一：\n' +
			'  1) 安装并启动 Docker Desktop 后重新运行本脚本（会自动执行 docker compose up -d postgres）；\n' +
			'  2) 自行安装/启动 PostgreSQL，并通过环境变量 PGHOST/PGPORT/DBUSER/DBPASS/DBNAME 指向它。'
		);
	}

	console.log('   未探测到可用 PostgreSQL，尝试通过 docker compose 启动...');
	run('docker', ['compose', 'up', '-d', 'postgres'], { cwd: root });

	const ok = await waitForTcpPort(PGHOST, PGPORT, { retries: 40, intervalMs: 1000, label: `PostgreSQL(${PGHOST}:${PGPORT})` });
	if (!ok) {
		throw new Error(`docker compose 已启动 postgres 容器，但 ${PGHOST}:${PGPORT} 在 40 秒内仍不可连接，请检查 docker compose logs postgres`);
	}
	console.log('   PostgreSQL 已就绪（docker compose）');
}
