'use strict';

/*
 * Mock App SSO backend — 模拟 App 后端的 OAuth2 授权码流。
 *
 * 这是「把难逻辑下沉到 App 后端」的落点：占位邮箱、会员群组的 add_groups/remove_groups、
 * member_* 自定义字段，全部由这里的 /userinfo 计算并返回，NodeBB 侧插件只负责消费。
 *
 * 端点：
 *   GET  /authorize   授权端点。无 login_as 时渲染账号选择页；带 login_as 时下发 code 并回跳。
 *   POST /token       用 code 换 access_token。
 *   GET  /userinfo    Bearer/access_token 换用户信息（双轨邮箱 + 群组同步逻辑在此）。
 *   GET  /_users      调试用：列出全部 mock 用户。
 */

const express = require('express');
const crypto = require('crypto');

const app = express();
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

const PORT = parseInt(process.env.SSO_PORT || '5555', 10);
const HOST = '127.0.0.1';
const CLIENT_ID = process.env.SSO_CLIENT_ID || 'chattodo-forum';
const CLIENT_SECRET = process.env.SSO_CLIENT_SECRET || 'chattodo-mock-secret';
const PLACEHOLDER_DOMAIN = 'users.bbs.chattodo.local';

// —— 模拟 App 用户库 ——
// groups 只含 m- 前缀（SSO 只管理会员档位）；h-honor / beta 属论坛侧手动身份，绝不经 SSO。
const USERS = {
	paid: {
		id: '10001', username: 'zhangming', displayname: '张明',
		email: 'zhangming@example.com', groups: ['m-paid'],
		member: { type: 'paid', since: '2026-01-15', expires: '2027-01-15' },
		note: '付费会员，展示会员头衔 + 头像角标',
	},
	phone: {
		id: '10002', username: 'shouji0921', displayname: '手机用户0921',
		email: null, groups: [],
		member: { type: 'free' },
		note: '纯手机号用户（无邮箱）→ 生成占位邮箱、跳过邮箱验证',
	},
	honor: {
		id: '10003', username: 'wangrongyu', displayname: '王荣誉',
		email: 'wangrongyu@example.com', groups: ['m-paid'],
		member: { type: 'paid', since: '2025-06-01', expires: '2027-06-01' },
		note: '付费会员，论坛侧再手动授予 h-honor → 荣誉+付费双徽章',
	},
	beta: {
		id: '10004', username: 'neice', displayname: '内测张三',
		email: 'neice@example.com', groups: ['m-paid'],
		member: { type: 'paid', since: '2026-03-01', expires: '2027-03-01' },
		note: '付费会员，论坛侧再手动加入 beta → 可见内测专区',
	},
	free: {
		id: '10005', username: 'lizovyou', displayname: '李自由',
		email: 'lizovyou@example.com', groups: [],
		member: { type: 'free' },
		note: '免费用户（基线，无角标）',
	},
};

// 全部可由 SSO 管理的 m- 群组（用于计算 remove_groups —— 前缀隔离的第一道保证）
const ALL_M_GROUPS = ['m-paid', 'm-pro', 'm-max', 'm-lifetime'];

const codes = new Map(); // code -> userKey
const tokens = new Map(); // token -> userKey

function pickerPage(redirectUri, state) {
	const rows = Object.entries(USERS).map(([key, u]) => {
		const href = `/authorize?client_id=${encodeURIComponent(CLIENT_ID)}` +
			`&redirect_uri=${encodeURIComponent(redirectUri)}` +
			`&state=${encodeURIComponent(state || '')}&login_as=${key}`;
		const tag = u.email ? u.member.type : `${u.member.type} · 手机号`;
		return `<li><a href="${href}"><b>${u.displayname}</b> <span class="tag">${tag}</span>
			<div class="note">${u.note}</div></a></li>`;
	}).join('');
	return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
		<meta name="viewport" content="width=device-width, initial-scale=1">
		<title>灵信账号登录（模拟）</title>
		<style>
			body{font-family:-apple-system,"PingFang SC","Microsoft YaHei",sans-serif;background:#f5f6f8;margin:0;padding:40px 16px;color:#1f2329}
			.card{max-width:460px;margin:0 auto;background:#fff;border-radius:14px;box-shadow:0 6px 24px rgba(0,0,0,.08);overflow:hidden}
			.head{background:linear-gradient(135deg,#3b6ef5,#7a5cff);color:#fff;padding:24px 28px}
			.head h1{margin:0;font-size:20px}.head p{margin:6px 0 0;opacity:.9;font-size:13px}
			ul{list-style:none;margin:0;padding:8px}
			li a{display:block;padding:14px 16px;border-radius:10px;text-decoration:none;color:#1f2329;transition:background .15s}
			li a:hover{background:#f0f4ff}
			.tag{font-size:12px;color:#3b6ef5;background:#eaf0ff;border-radius:6px;padding:2px 8px;margin-left:6px}
			.note{font-size:12px;color:#8a9099;margin-top:4px}
			.foot{padding:14px 28px;color:#8a9099;font-size:12px;border-top:1px solid #eef0f3}
		</style></head><body><div class="card">
		<div class="head"><h1>灵信账号登录</h1><p>模拟 App 账号体系（DiscourseConnect 风格 SSO）· 选择一个身份继续</p></div>
		<ul>${rows}</ul>
		<div class="foot">这是本地演示用的模拟登录页，真实环境将委托 App 后端完成鉴权。</div>
		</div></body></html>`;
}

app.get('/authorize', (req, res) => {
	const { redirect_uri: redirectUri, state, login_as: loginAs } = req.query;
	if (!redirectUri) {
		return res.status(400).send('missing redirect_uri');
	}
	if (!loginAs || !USERS[loginAs]) {
		res.set('Content-Type', 'text/html; charset=utf-8');
		return res.send(pickerPage(redirectUri, state));
	}
	const code = crypto.randomBytes(16).toString('hex');
	codes.set(code, loginAs);
	const url = new URL(redirectUri);
	url.searchParams.set('code', code);
	if (state) {
		url.searchParams.set('state', state);
	}
	return res.redirect(url.toString());
});

app.post('/token', (req, res) => {
	const code = req.body.code || req.query.code;
	const userKey = codes.get(code);
	if (!userKey) {
		return res.status(400).json({ error: 'invalid_grant' });
	}
	codes.delete(code);
	const token = crypto.randomBytes(24).toString('hex');
	tokens.set(token, userKey);
	return res.json({ access_token: token, token_type: 'Bearer', expires_in: 3600, scope: 'profile email' });
});

app.get('/userinfo', (req, res) => {
	const header = req.headers.authorization || '';
	const token = header.replace(/^Bearer\s+/i, '') || req.query.access_token;
	const userKey = tokens.get(token);
	if (!userKey) {
		return res.status(401).json({ error: 'invalid_token' });
	}
	const u = USERS[userKey];
	// —— 双轨邮箱：有邮箱直传；纯手机号用户生成确定性占位邮箱 ——
	const email = u.email || `u${u.id}@${PLACEHOLDER_DOMAIN}`;
	const addGroups = u.groups.slice(); // 仅 m- 群组
	const removeGroups = ALL_M_GROUPS.filter(g => !u.groups.includes(g)); // 未持有的 m- 群组；绝不含 h-/beta
	return res.json({
		id: u.id,
		username: u.username,
		displayname: u.displayname,
		email,
		email_verified: true,
		phone_only: !u.email,
		add_groups: addGroups,
		remove_groups: removeGroups,
		member_type: u.member.type,
		member_since: u.member.since || '',
		member_expires: u.member.expires || '',
	});
});

app.get('/_users', (req, res) => res.json(USERS));
app.get('/_health', (req, res) => res.json({ ok: true, service: 'mock-sso' }));

app.listen(PORT, HOST, () => {
	// eslint-disable-next-line no-console
	console.log(`[mock-sso] OAuth2 App backend on http://${HOST}:${PORT} (client_id=${CLIENT_ID})`);
});
