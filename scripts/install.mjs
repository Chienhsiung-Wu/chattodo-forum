#!/usr/bin/env node
'use strict';
//
// 一键重建论坛环境（幂等）。nodebb/ 目录不入库，本脚本从零克隆并配置。
// 纯 Node.js 实现，Windows / macOS / Linux 通用（不依赖 bash / pg_ctlcluster / ln -sfn）。
// 前置：Node >= 22、Docker（用于 Postgres，若已有可连接的 Postgres 会自动复用）、可访问 npm registry 与 github。
//
// 用法：npm run setup
//
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { run, runNode, npmCmd } from './lib/proc.mjs';
import { ensurePostgresUp, PGHOST, PGPORT, DBNAME, DBUSER, DBPASS } from './lib/postgres.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const NBB = path.join(ROOT, 'nodebb');
const NBB_VERSION = 'v4.11.3';
const NBB_URL = process.env.NBB_URL || 'http://localhost:4567';

const PLUGINS = ['nodebb-plugin-chattodo-sso', 'nodebb-plugin-chattodo-forum'];

function log(step, msg) { console.log(`==> ${step} ${msg}`); }

function checkNodeVersion() {
	log('1/8', '检查 Node 版本 (需 >= 22)');
	const major = parseInt(process.versions.node, 10);
	if (major < 22) {
		throw new Error(`当前 Node 版本 ${process.versions.node} < 22，请升级后重试（NodeBB v4 要求 Node >= 22）`);
	}
}

function cloneNodebb() {
	log('2/8', `克隆 NodeBB ${NBB_VERSION}`);
	if (fs.existsSync(path.join(NBB, '.git'))) {
		console.log('   已存在，跳过克隆');
		return;
	}
	run('git', ['clone', '--depth', '1', '--branch', NBB_VERSION, 'https://github.com/NodeBB/NodeBB.git', NBB]);
}

function installNodebbDeps() {
	log('3/8', '安装 NodeBB 依赖');
	run(npmCmd(), ['install', '--no-audit', '--no-fund'], { cwd: NBB });
}

function applyPatch() {
	log('4/8', '施加核心补丁（EMFILE 分批并发）');
	runNode(path.join(ROOT, 'scripts/patch-nodebb.js'));
}

function setupNodebb() {
	log('5/8', '生成 config.json 并初始化（若不存在）');
	const configFile = path.join(NBB, 'config.json');
	if (fs.existsSync(configFile)) {
		console.log('   config.json 已存在，跳过 setup');
		return;
	}
	const secret = crypto.randomBytes(32).toString('hex');
	const adminPassword = process.env.ADMIN_PASSWORD || `Ct!${crypto.randomBytes(9).toString('base64url')}`;
	const setupConfig = {
		url: NBB_URL,
		secret,
		database: 'postgres',
		port: '4567',
		'postgres:host': PGHOST,
		'postgres:port': String(PGPORT),
		'postgres:username': DBUSER,
		'postgres:password': DBPASS,
		'postgres:database': DBNAME,
		'postgres:ssl': false,
		'admin:username': 'siteadmin',
		'admin:email': 'admin@bbs.chattodo.local',
		'admin:password': adminPassword,
		'admin:password:confirm': adminPassword,
	};
	fs.writeFileSync(path.join(ROOT, 'scripts/setup.json'), JSON.stringify(setupConfig, null, 2));

	runNode(path.join(NBB, 'nodebb'), ['setup', JSON.stringify(setupConfig)], { cwd: NBB });

	// threads=1 → maxThreads=0，禁用 minifier 子进程 fork，换取跨平台下更可靠、可复现的构建行为。
	const cfg = JSON.parse(fs.readFileSync(configFile, 'utf8'));
	cfg.threads = 1;
	fs.writeFileSync(configFile, JSON.stringify(cfg, null, 4));

	console.log(`   ★ 管理员账号 siteadmin / 密码：${adminPassword}`);
}

function linkPlugin(name) {
	const target = path.join(ROOT, 'plugins', name);
	const dest = path.join(NBB, 'node_modules', name);
	if (fs.existsSync(dest)) {
		fs.rmSync(dest, { recursive: true, force: true });
	}
	// 'junction' 在 Windows 上无需管理员权限即可创建目录链接；POSIX 上等同普通符号链接。
	fs.symlinkSync(target, dest, 'junction');
}

function installPlugins() {
	log('6/8', '自研插件：依赖 + 链接 + 激活');
	run(npmCmd(), ['install', 'passport-oauth2@1.8.0', '--no-audit', '--no-fund'], { cwd: NBB });
	for (const name of PLUGINS) { linkPlugin(name); }
	// `nodebb activate` 每次只接受一个插件名，需逐个调用。
	for (const name of PLUGINS) {
		runNode(path.join(NBB, 'nodebb'), ['activate', name], { cwd: NBB });
	}
}

function buildAssets() {
	log('7/8', '构建前端资源');
	runNode(path.join(NBB, 'nodebb'), ['build'], { cwd: NBB });
}

function bootstrap() {
	log('8/8', '初始化结构与种子内容');
	runNode(path.join(ROOT, 'scripts/bootstrap.js'));
}

async function main() {
	checkNodeVersion();
	console.log('==> 确保 PostgreSQL 可用');
	await ensurePostgresUp(ROOT);
	cloneNodebb();
	installNodebbDeps();
	applyPatch();
	setupNodebb();
	installPlugins();
	buildAssets();
	bootstrap();

	console.log('');
	console.log('✅ 安装完成。启动全部服务： npm run dev');
	console.log('   验收截图：            npm run screenshots');
}

main().catch((err) => {
	console.error('\n[install] 失败:', err.message || err);
	process.exit(1);
});
