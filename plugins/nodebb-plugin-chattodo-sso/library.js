'use strict';

/*
 * LinX SSO —— 委托 App 后端的 OAuth2 登录（DiscourseConnect 风格）。
 *
 * 职责（对应 PRD FR-1 / FR-2）：
 *   - external_id 与论坛账号一一绑定（chattodoid:uid 映射）；
 *   - 双轨邮箱：真实邮箱直传，纯手机号用户用 App 侧下发的占位邮箱，且跳过邮箱验证；
 *   - 会员群组同步：只增删 m- 前缀群组（前缀隔离），h-/beta 由论坛侧独立管理，永不经 SSO 移除；
 *   - 主群组角标：按 荣誉 > 永久 > 高档付费 > 付费 的优先级设置 groupTitle，决定头像 flair；
 *   - member_type / member_since / member_expires 自定义字段先存储（为富展示预留）。
 *
 * 「难逻辑」（占位邮箱、add_groups/remove_groups、会员字段）由 mock App 后端的 /userinfo 计算，
 * 本插件只消费其结果 —— 与真实环境的对接契约一致。
 */

const passport = require.main.require('passport');
// 经 require.main（NodeBB 入口）解析，命中 nodebb/node_modules —— 符号链接插件的相对 require 无法直达该目录
const OAuth2Strategy = require.main.require('passport-oauth2');
const nconf = require.main.require('nconf');
const winston = require.main.require('winston');

const User = require.main.require('./src/user');
const Groups = require.main.require('./src/groups');
const db = require.main.require('./src/database');

const Plugin = module.exports;

const SSO_BASE = process.env.SSO_BASE || 'http://127.0.0.1:5555';
const constants = {
	name: 'chattodo',
	callbackURL: '/auth/chattodo/callback',
	scope: 'profile email',
	clientID: process.env.SSO_CLIENT_ID || 'chattodo-forum',
	clientSecret: process.env.SSO_CLIENT_SECRET || 'chattodo-mock-secret',
};

// 角标优先级：数组越靠前优先级越高（荣誉 > 永久 > 高档付费 > 付费）
const FLAIR_PRIORITY = ['h-honor', 'm-lifetime', 'm-max', 'm-pro', 'm-paid'];
const MANAGED_PREFIX = 'm-'; // SSO 只能移除该前缀群组

Plugin.init = async function () {
	winston.info('[chattodo-sso] 已加载，SSO 后端: ' + SSO_BASE);
};

Plugin.getStrategy = async function (strategies) {
	const strategy = new OAuth2Strategy({
		authorizationURL: `${SSO_BASE}/authorize`,
		tokenURL: `${SSO_BASE}/token`,
		clientID: constants.clientID,
		clientSecret: constants.clientSecret,
		callbackURL: nconf.get('url') + constants.callbackURL,
		passReqToCallback: true,
	}, async (req, accessToken, refreshToken, profile, done) => {
		try {
			const user = await Plugin.login(profile);
			// SSO 直登无需注册插页：清除路由预置的 registration 会话，避免后续请求被拦到 /register/complete
			if (req && req.session && req.session.registration) {
				delete req.session.registration;
			}
			done(null, user);
		} catch (err) {
			winston.error('[chattodo-sso] 登录失败: ' + err.stack);
			done(err);
		}
	});

	// node-oauth 默认把 token 放 query；确保也带上 Authorization header
	strategy._oauth2.useAuthorizationHeaderforGET(true);

	// 覆写 userProfile：从 App 后端 /userinfo 拉取用户信息
	strategy.userProfile = function (accessToken, cb) {
		this._oauth2.get(`${SSO_BASE}/userinfo`, accessToken, (err, body) => {
			if (err) {
				return cb(err);
			}
			try {
				return cb(null, JSON.parse(body));
			} catch (e) {
				return cb(e);
			}
		});
	};

	passport.use(constants.name, strategy);

	strategies.push({
		name: constants.name,
		url: `/auth/${constants.name}`,
		callbackURL: constants.callbackURL,
		icon: 'fa-right-to-bracket',
		labelText: '使用 灵信账号登录',
		color: '#ffffff',
		scope: constants.scope,
	});

	return strategies;
};

// 核心：external_id → 论坛 uid，创建/匹配 + 同步
Plugin.login = async function (profile) {
	const oAuthid = String(profile.id);
	const email = profile.email; // mock 已按双轨规则算好（真实或占位）
	const isPlaceholder = !!profile.phone_only;

	let uid = await db.getObjectField(`${constants.name}id:uid`, oAuthid);
	uid = uid ? parseInt(uid, 10) : null;

	if (!uid) {
		// 首次登录：真实邮箱可尝试按邮箱匹配既有账号；占位邮箱不参与匹配
		if (email && !isPlaceholder) {
			uid = await User.getUidByEmail(email);
		}
		if (!uid) {
			// 第二参 opts.emailVerification='verify' → 直接写入并确认邮箱（含占位邮箱），不发验证邮件
			uid = await User.create({ username: profile.username, email }, { emailVerification: 'verify' });
		}
		uid = parseInt(uid, 10);
		await User.setUserField(uid, `${constants.name}id`, oAuthid);
		await db.setObjectField(`${constants.name}id:uid`, oAuthid, uid);
	}

	// 邮箱同步（含占位邮箱）：写入并确认，不发验证邮件；也覆盖 App 侧邮箱变更、回填历史账号
	if (email) {
		const currentEmail = await User.getUserField(uid, 'email');
		if (String(currentEmail || '') !== String(email)) {
			await User.setUserField(uid, 'email', email);
			try {
				await User.email.confirmByUid(uid);
			} catch (e) {
				winston.warn('[chattodo-sso] 邮箱确认跳过: ' + e.message);
			}
		}
	}
	await User.setUserField(uid, 'email:confirmed', 1);
	await db.sortedSetRemove('users:notvalidated', uid);

	// 显示名 + 会员自定义字段（存储，暂不渲染 —— 为富展示预留）
	await User.setUserFields(uid, {
		fullname: profile.displayname || profile.username,
		member_type: profile.member_type || '',
		member_since: profile.member_since || '',
		member_expires: profile.member_expires || '',
	});

	// 会员群组同步（m- 前缀隔离）+ 主群组角标
	await Plugin.syncGroups(uid, profile.add_groups || [], profile.remove_groups || []);
	await Plugin.syncFlair(uid);

	return { uid };
};

Plugin.syncGroups = async function (uid, addGroups, removeGroups) {
	for (const g of addGroups) {
		// eslint-disable-next-line no-await-in-loop
		if (await Groups.exists(g)) {
			// eslint-disable-next-line no-await-in-loop
			await Groups.join(g, uid);
		}
	}
	for (const g of removeGroups) {
		// 前缀隔离的第二道保证：SSO 永远只移除 m- 前缀群组
		if (!g.startsWith(MANAGED_PREFIX)) {
			continue;
		}
		// eslint-disable-next-line no-await-in-loop
		if (await Groups.isMember(uid, g)) {
			// eslint-disable-next-line no-await-in-loop
			await Groups.leave(g, uid);
		}
	}
};

Plugin.syncFlair = async function (uid) {
	let primary = null;
	for (const g of FLAIR_PRIORITY) {
		// eslint-disable-next-line no-await-in-loop
		if (await Groups.isMember(uid, g)) {
			primary = g;
			break;
		}
	}
	if (primary) {
		await User.setUserField(uid, 'groupTitle', JSON.stringify([primary]));
	}
};
