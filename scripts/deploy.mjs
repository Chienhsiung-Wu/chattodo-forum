#!/usr/bin/env node
'use strict';
//
// 一键发布到 VPS：推送代码 → SSH 拉取 → npm install → setup → 重启服务。
// 凭据在 .env.deploy（本地文件，.gitignore 已忽略），模板见 .env.example.deploy。
//
// 前置：
//   1. VPS 已按 DEPLOY.md 完成首次部署
//   2. 本机安装了 plink.exe（PuTTY 命令行工具）
//   3. 当前分支已关联 origin
//
// 用法：npm run deploy
//
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

// ── 读取 .env.deploy ────────────────────────────────────────────
function loadEnv(file) {
	const p = path.join(ROOT, file);
	if (!fs.existsSync(p)) {
		console.error(`[deploy] 缺少 ${file}。请复制 .env.example.deploy 为 .env.deploy 并填好凭据。`);
		process.exit(1);
	}
	const vars = {};
	for (const line of fs.readFileSync(p, 'utf8').split(/\r?\n/)) {
		const trimmed = line.trim();
		if (!trimmed || trimmed.startsWith('#')) { continue; }
		const eq = trimmed.indexOf('=');
		if (eq === -1) { continue; }
		vars[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim();
	}
	return vars;
}

const env = loadEnv('.env.deploy');

const VPS_IP = env.VPS_IP;
const VPS_USER = env.VPS_USER || 'root';
const VPS_PASSWORD = env.VPS_PASSWORD;
const PROJECT_DIR = env.VPS_PROJECT_DIR || '/opt/chattodo-forum';
const BRANCH = env.VPS_BRANCH || 'master';

if (!VPS_IP || !VPS_PASSWORD) {
	console.error('[deploy] .env.deploy 中 VPS_IP 和 VPS_PASSWORD 为必填项。');
	process.exit(1);
}

// ── plink 路径 ───────────────────────────────────────────────────
function resolvePlink() {
	if (process.env.PLINK_BIN && fs.existsSync(process.env.PLINK_BIN)) {
		return process.env.PLINK_BIN;
	}
	// Windows 常见安装路径
	for (const p of ['D:\\software\\putty\\plink.exe', 'C:\\Program Files\\PuTTY\\plink.exe']) {
		if (fs.existsSync(p)) { return p; }
	}
	return 'plink'; // 交给 PATH
}

const PLINK = resolvePlink();

function ssh(cmd) {
	const esc = cmd.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
	return execSync(
		`echo y | "${PLINK}" -pw "${VPS_PASSWORD}" -P 22 ${VPS_USER}@${VPS_IP} "${esc}"`,
		{ encoding: 'utf8', stdio: 'pipe' }
	);
}

function sshOut(cmd) {
	// 把 stdout 原样透传给本机终端
	const esc = cmd.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
	return execSync(
		`echo y | "${PLINK}" -pw "${VPS_PASSWORD}" -P 22 ${VPS_USER}@${VPS_IP} "${esc}"`,
		{ encoding: 'utf8', stdio: 'inherit' }
	);
}

// ── 主流程 ──────────────────────────────────────────────────────
function log(msg) { console.log(`==> ${msg}`); }

function main() {
	// 1) 确认 git 工作区干净
	log('1/6 检查 git 工作区');
	const status = execSync('git status --porcelain', { encoding: 'utf8', cwd: ROOT }).trim();
	if (status) {
		console.error('[deploy] 工作区不干净，请先 commit 或 stash 变更：');
		console.error(execSync('git status --short', { encoding: 'utf8', cwd: ROOT }));
		process.exit(1);
	}
	console.log('   工作区干净 ✓');

	// 2) 推送当前分支
	log('2/6 推送代码到 origin');
	const currentBranch = execSync('git rev-parse --abbrev-ref HEAD', { encoding: 'utf8', cwd: ROOT }).trim();
	console.log(`   当前分支: ${currentBranch}`);
	execSync(`git push origin ${currentBranch}`, { encoding: 'utf8', stdio: 'inherit', cwd: ROOT });
	console.log('   推送完成 ✓');

	// 3) VPS 拉取最新代码
	log('3/6 VPS 拉取代码');
	sshOut("cd ${PROJECT_DIR} && sudo -u nodebb git -C ${PROJECT_DIR} config --global --add safe.directory ${PROJECT_DIR} 2>/dev/null; sudo -u nodebb git -C ${PROJECT_DIR} fetch origin && sudo -u nodebb git -C ${PROJECT_DIR} checkout ${BRANCH} && sudo -u nodebb git -C ${PROJECT_DIR} reset --hard origin/${BRANCH}");
	console.log('   拉取完成 ✓');

	// 4) 安装根目录依赖
	log('4/6 VPS 安装依赖');
	sshOut(`cd ${PROJECT_DIR} && sudo -u nodebb npm install --no-audit --no-fund`);
	console.log('   依赖安装完成 ✓');

	// 5) 幂等 re-setup（补丁 + 插件 + 构建 + bootstrap）
	log('5/6 VPS 运行 setup（幂等）');
	sshOut(`cd ${PROJECT_DIR} && sudo -u nodebb bash -c 'set -a; . ./.env; set +a; npm run setup'`);
	console.log('   setup 完成 ✓');

	// 6) 重启 systemd 服务
	log('6/6 重启论坛服务');
	sshOut('sudo systemctl restart chattodo-forum');

	// 短暂等待后输出状态
	const state = ssh('systemctl is-active chattodo-forum && journalctl -u chattodo-forum -n 5 --no-pager').trim();
	console.log('');
	console.log(state);
	console.log('');
	console.log('✅ 发布完成！');
	console.log(`   论坛地址：http://${VPS_IP}:4567/`);
}

main();
