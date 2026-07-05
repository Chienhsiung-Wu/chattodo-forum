'use strict';

/*
 * 论坛结构与内容一键初始化（幂等）。对应 PRD FR-2 / FR-3 / FR-4 / FR-6。
 * 直接加载 NodeBB 核心模块操作数据库；运行前需 config.json 已生成（./nodebb setup 完成）。
 * 用法：node scripts/bootstrap.js   （建议运行后重启 NodeBB 以刷新缓存）
 */

const path = require('path');
const nconf = require('nconf');

const NBB = path.resolve(__dirname, '../nodebb');
nconf.argv().env({ separator: '__' });
const prestart = require(path.join(NBB, 'src/prestart'));
prestart.setupWinston();
prestart.loadConfig(path.join(NBB, 'config.json'));

const db = require(path.join(NBB, 'src/database'));
const meta = require(path.join(NBB, 'src/meta'));
const Groups = require(path.join(NBB, 'src/groups'));
const Categories = require(path.join(NBB, 'src/categories'));
const User = require(path.join(NBB, 'src/user'));
const Topics = require(path.join(NBB, 'src/topics'));
const Posts = require(path.join(NBB, 'src/posts'));
const privileges = require(path.join(NBB, 'src/privileges'));
const seed = require('./seed-data');

function log(...a) { console.log('[bootstrap]', ...a); }

// —— 会员/身份群组（FR-2）——
const GROUPS = [
	{ name: 'm-paid', userTitle: '会员', icon: 'fa-gem', labelColor: '#3b82f6' },
	{ name: 'm-pro', userTitle: '专业会员', icon: 'fa-star', labelColor: '#6366f1' },
	{ name: 'm-max', userTitle: '旗舰会员', icon: 'fa-bolt', labelColor: '#8b5cf6' },
	{ name: 'm-lifetime', userTitle: '永久会员', icon: 'fa-infinity', labelColor: '#0ea5e9' },
	{ name: 'h-honor', userTitle: '荣誉会员', icon: 'fa-crown', labelColor: '#f59e0b' },
	{ name: 'beta', userTitle: '内测体验官', icon: 'fa-flask', labelColor: '#10b981' },
];
// 角标优先级：荣誉 > 永久 > 旗舰 > 专业 > 付费
const FLAIR_PRIORITY = ['h-honor', 'm-lifetime', 'm-max', 'm-pro', 'm-paid'];

// —— 版块（FR-3）——
const CATS = [
	{ role: 'announce', name: '公告', description: '版本更新、活动、规则、内测招募。仅官方发帖，全员可读可回。', icon: 'fa-bullhorn', bgColor: '#e74c3c' },
	{ role: 'suggestion', name: '功能建议', description: '提出你的需求并投票，官方每周据票数评审，并用状态标签公开流转。', icon: 'fa-lightbulb', bgColor: '#f39c12' },
	{ role: 'bug', name: 'Bug 反馈', description: '请按话题模板提交，信息完整、无需追问能极大加快定位。', icon: 'fa-bug', bgColor: '#c0392b' },
	{ role: 'qa', name: '使用问答', description: '先搜索再提问，问题解决后可标记「已解决」。', icon: 'fa-circle-question', bgColor: '#2980b9' },
	{ role: 'share', name: '玩法分享', description: 'Prompt、Agent 工作流、Todo 方法论与场景案例——来了有收获。分享截图请隐去个人待办的真实内容，涉及他人信息务必脱敏。', icon: 'fa-wand-magic-sparkles', bgColor: '#8e44ad' },
	{ role: 'beta', name: '内测专区', description: '内测体验官专属版块，内容涉密，请勿外传。', icon: 'fa-flask', bgColor: '#16a085' },
];

const STATUS_TAGS = ['已计划', '开发中', '已上线', '暂不考虑'];
const SHARE_TAGS = ['prompt', '工作流', '方法论', '案例'];
const SOLVED_TAG = '已解决';

const BUG_TEMPLATE = [
	'【问题描述】', '用一两句话说明遇到了什么问题。', '',
	'【复现步骤】', '1. ', '2. ', '3. ', '',
	'【期望行为】', '你认为正确的表现应该是什么。', '',
	'【实际行为】', '实际发生了什么（如有报错，请贴出完整报错信息）。', '',
	'【AI 相关信息】（涉及 AI / Agent 功能时填写）',
	'- 你给 AI 的指令或触发的自动化：',
	'- AI 的实际输出（截图请先隐去个人待办内容）：', '',
	'【环境信息】', '- 设备型号：', '- 系统版本：', '- App 版本号：（可在「设置 - 关于」中查看）', '',
	'【截图 / 录屏】', '如有请直接拖拽上传，能极大加快定位速度。',
].join('\n');

// 分类视图/发帖权限（group 形式）
const VIEW_POST_PRIVS = [
	'groups:find', 'groups:read', 'groups:topics:read', 'groups:topics:create',
	'groups:topics:reply', 'groups:topics:tag', 'groups:posts:edit', 'groups:posts:history',
	'groups:posts:delete', 'groups:posts:upvote', 'groups:posts:downvote', 'groups:topics:delete',
];

// —— 官方账号（FR-6）——
const STAFF = [
	{ username: 'chanpin', fullname: '产品同学', admin: true },
	{ username: 'kaifa', fullname: '开发同学' },
	{ username: 'yunying', fullname: '运营同学' },
];

// —— 会员演示账号（复刻 SSO 登录后的终态；h-honor/beta 为论坛侧手动身份）——
const MEMBERS = [
	{ chattodoid: '10001', username: 'zhangming', fullname: '张明', email: 'zhangming@example.com', groups: ['m-paid'] },
	{ chattodoid: '10002', username: 'shouji0921', fullname: '手机用户0921', email: 'u10002@users.bbs.chattodo.local', groups: [] },
	{ chattodoid: '10003', username: 'wangrongyu', fullname: '王荣誉', email: 'wangrongyu@example.com', groups: ['m-paid', 'h-honor'] },
	{ chattodoid: '10004', username: 'neice', fullname: '内测张三', email: 'neice@example.com', groups: ['m-paid', 'beta'] },
	{ chattodoid: '10005', username: 'lizovyou', fullname: '李自由', email: 'lizovyou@example.com', groups: [] },
];

async function ensureGroups() {
	for (const g of GROUPS) {
		if (!(await Groups.exists(g.name))) {
			await Groups.create({ name: g.name, description: g.userTitle, hidden: 0, private: 1, disableJoinRequests: 1 });
			log('群组已建', g.name);
		}
		await db.setObject(`group:${g.name}`, {
			userTitle: g.userTitle, userTitleEnabled: 1, icon: g.icon,
			labelColor: g.labelColor, textColor: '#ffffff',
		});
	}
}

async function ensureCategories() {
	const cids = await Categories.getAllCidsFromSet('categories:cid');
	const roleToCid = {};
	for (const cid of cids) {
		const r = await Categories.getCategoryField(cid, 'chattodoRole');
		if (r) { roleToCid[r] = cid; }
	}
	let order = 1;
	for (const c of CATS) {
		let cid = roleToCid[c.role];
		if (!cid) {
			const created = await Categories.create({
				name: c.name, description: c.description, icon: c.icon,
				bgColor: c.bgColor, color: '#ffffff', order: order,
			});
			cid = created.cid;
			await Categories.setCategoryField(cid, 'chattodoRole', c.role);
			log('版块已建', c.name, '→ cid', cid);
		} else {
			await db.setObject(`category:${cid}`, {
				name: c.name, description: c.description, icon: c.icon, bgColor: c.bgColor, order: order,
			});
		}
		roleToCid[c.role] = cid;
		order += 1;
	}
	// 停用 NodeBB 自带的默认版块（无 chattodoRole 标记者），只保留 PRD 六版块
	const keep = new Set(Object.values(roleToCid).map(String));
	for (const cid of cids) {
		if (!keep.has(String(cid))) {
			await Categories.setCategoryField(cid, 'disabled', 1);
			log('停用默认版块 cid', cid);
		}
	}
	return roleToCid;
}

async function setTagWhitelist(cid, tags) {
	await db.delete(`cid:${cid}:tag:whitelist`);
	if (tags.length) {
		await db.sortedSetAdd(`cid:${cid}:tag:whitelist`, tags.map((_, i) => i), tags);
	}
}

async function configureCategories(roleToCid) {
	// Bug：强制话题模板 + 允许「已解决」标签
	await Categories.setCategoryField(roleToCid.bug, 'topicTemplate', BUG_TEMPLATE);
	await setTagWhitelist(roleToCid.bug, [SOLVED_TAG]);
	// 使用问答：允许「已解决」标签
	await setTagWhitelist(roleToCid.qa, [SOLVED_TAG]);
	// 玩法分享：四个方向标签白名单
	await setTagWhitelist(roleToCid.share, SHARE_TAGS);
	// 功能建议：状态标签白名单
	await setTagWhitelist(roleToCid.suggestion, STATUS_TAGS);

	// 公告：仅官方可发帖 —— 回收 registered-users 的建帖权
	await privileges.categories.rescind(['groups:topics:create'], roleToCid.announce, ['registered-users']);

	// 内测专区：私有，仅 beta 群组可见可发 —— 回收公众/注册用户，仅授予 beta
	await privileges.categories.rescind(VIEW_POST_PRIVS, roleToCid.beta, ['registered-users', 'guests', 'spiders']);
	await privileges.categories.give(VIEW_POST_PRIVS, roleToCid.beta, ['beta']);
	log('版块权限与标签白名单已配置');
}

async function applyConfig(roleToCid) {
	await meta.configs.setMultiple({
		title: 'ChatTodo 社区',
		'brand:name': 'ChatTodo 社区',
		description: 'ChatTodo —— AI + Agent + Todo 的官方中文社区',
		defaultLang: 'zh-CN',
		showfullname: 1,
		'theme:src': '',
		themeColor: '#3b6ef5',
		allowGuestSearching: 1,
		// 关闭 GDPR/邮箱注册插页：SSO 场景下同意与账号信息以 App 为准，避免登录后被拦到 /register/complete
		gdpr_enabled: 0,
		requireEmailAddress: 0,
		requireEmailConfirmation: 0,
		// 关闭新用户发帖节流，便于种子内容一次性灌入
		initialPostDelay: 0,
		newbiePostDelay: 0,
		newbieReputationThreshold: 0,
		postDelay: 0,
		postQueue: 0,
		// 自定义键：供 forum 插件读取
		'chattodo:suggestionCid': String(roleToCid.suggestion),
		'chattodo:imCids': `${roleToCid.suggestion},${roleToCid.bug}`,
		'chattodo:statusTags': STATUS_TAGS.join(','),
	});
	// 同步进程内缓存，确保本次种子灌入立即生效
	meta.config.initialPostDelay = 0;
	meta.config.newbiePostDelay = 0;
	meta.config.newbieReputationThreshold = 0;
	meta.config.postDelay = 0;
	log('站点配置已写入（语言 zh-CN、品牌、chattodo:* 键、关闭发帖节流）');
}

async function findUidByUsername(username) {
	const slug = username.toLowerCase();
	return await db.sortedSetScore('username:uid', username) || await User.getUidByUserslug(slug);
}

async function ensureStaff() {
	const map = {};
	for (const s of STAFF) {
		let uid = await findUidByUsername(s.username);
		if (!uid) {
			uid = await User.create({ username: s.username, email: `${s.username}@bbs.chattodo.local` }, { emailVerification: 'verify' });
			log('官方账号已建', s.fullname, 'uid', uid);
		}
		uid = parseInt(uid, 10);
		await User.setUserFields(uid, { fullname: s.fullname, 'email:confirmed': 1 });
		await Groups.join('Global Moderators', uid); // staff 高亮
		if (s.admin) { await Groups.join('administrators', uid); }
		map[s.username] = uid;
	}
	return map;
}

async function ensureMembers() {
	const map = {};
	for (const m of MEMBERS) {
		let uid = await db.getObjectField('chattodoid:uid', m.chattodoid);
		uid = uid ? parseInt(uid, 10) : null;
		if (!uid) { uid = await findUidByUsername(m.username); uid = uid ? parseInt(uid, 10) : null; }
		if (!uid) {
			uid = await User.create({ username: m.username, email: m.email }, { emailVerification: 'verify' });
			uid = parseInt(uid, 10);
			log('会员账号已建', m.fullname, 'uid', uid);
		}
		await User.setUserFields(uid, { fullname: m.fullname, 'email:confirmed': 1, chattodoid: m.chattodoid });
		await db.setObjectField('chattodoid:uid', m.chattodoid, uid);
		for (const g of m.groups) { await Groups.join(g, uid); }
		// 主群组角标
		let primary = null;
		for (const g of FLAIR_PRIORITY) { if (m.groups.includes(g)) { primary = g; break; } }
		if (primary) { await User.setUserField(uid, 'groupTitle', JSON.stringify([primary])); }
		map[m.username] = uid;
	}
	return map;
}

async function castVotes(pid, n, authorUid, memberUids) {
	const voters = memberUids.filter(u => u !== authorUid).slice(0, n);
	for (const v of voters) {
		try { await Posts.upvote(pid, v); } catch (e) { log('投票跳过', e.message); }
	}
}

async function seedContent(roleToCid, staffMap, memberMap) {
	const authorMap = { ...staffMap, ...memberMap };
	const adminUid = staffMap.chanpin;
	const memberUids = Object.values(memberMap);
	const plan = [
		['announce', seed.announce], ['qa', seed.qa], ['bug', seed.bug],
		['suggestion', seed.suggestion], ['share', seed.share],
	];
	for (const [role, items] of plan) {
		const cid = roleToCid[role];
		const topicCount = parseInt(await Categories.getCategoryField(cid, 'topic_count'), 10) || 0;
		if (topicCount > 0) { log('跳过种子（版块已有话题）', role); continue; }
		for (const item of items) {
			const uid = authorMap[item.author] || adminUid;
			const tags = [];
			if (item.tag) { tags.push(item.tag); }
			if (item.status) { tags.push(item.status); }
			if (item.solved) { tags.push(SOLVED_TAG); }
			const res = await Topics.post({ uid, cid, title: item.title, content: item.content, tags });
			const tid = res.topicData.tid;
			const pid = res.postData.pid;
			if (item.pinned) { try { await Topics.tools.pin(tid, adminUid); } catch (e) { /* noop */ } }
			if (item.votes) { await castVotes(pid, item.votes, uid, memberUids); }
		}
		log('已灌入种子', role, `(${items.length} 帖)`);
	}
}

async function main() {
	await db.init();
	await meta.configs.init();

	await ensureGroups();
	const roleToCid = await ensureCategories();
	await configureCategories(roleToCid);
	await applyConfig(roleToCid);
	const staffMap = await ensureStaff();
	const memberMap = await ensureMembers();
	await seedContent(roleToCid, staffMap, memberMap);

	log('✅ 初始化完成');
	log('版块 cid 映射:', JSON.stringify(roleToCid));
	await db.close();
	process.exit(0);
}

main().catch((err) => { console.error('[bootstrap] 失败:', err.stack || err); process.exit(1); });
