'use strict';

/*
 * 灵信论坛侧薄逻辑（对应 PRD FR-4.1 / FR-4.2 / FR-5）。
 * 全部为服务端 hook，无客户端资源；相关分类/标签由 bootstrap 写入以下 meta 配置：
 *   chattodo:suggestionCid  功能建议分类 cid（强制按票排序）
 *   chattodo:imCids         需推送 IM 的分类 cid（逗号分隔：功能建议,Bug反馈）
 *   chattodo:statusTags     状态标签（逗号分隔：已计划,开发中,已上线,暂不考虑）—— 仅 staff 可打
 */

const http = require('http');
const winston = require.main.require('winston');
const nconf = require.main.require('nconf');
const meta = require.main.require('./src/meta');
const user = require.main.require('./src/user');
const groups = require.main.require('./src/groups');
const categories = require.main.require('./src/categories');

const Plugin = module.exports;

const IM_URL = process.env.IM_WEBHOOK || 'http://127.0.0.1:5566/im/webhook';

function cfgList(key) {
	const v = meta.config[key];
	return (typeof v === 'string' && v) ? v.split(',').map(s => s.trim()).filter(Boolean) : [];
}

Plugin.init = async function () {
	winston.info('[chattodo-forum] 已加载，IM 中转: ' + IM_URL);
};

// FR-4.1 —— 功能建议分类默认按票数排序（用户显式选择其它排序时不覆盖）
Plugin.forceSuggestionSort = async function (hookData) {
	const suggestionCid = parseInt(meta.config['chattodo:suggestionCid'] || 0, 10);
	const cid = parseInt(hookData.data && hookData.data.cid, 10);
	const sort = hookData.data && hookData.data.sort;
	// 控制器总会把 sort 落到默认值 recently_replied；将「默认」映射为按票排序，
	// 用户显式选择 most_posts / most_views / recently_created 时仍尊重其选择。
	if (suggestionCid && cid === suggestionCid && (!sort || sort === 'recently_replied')) {
		hookData.set = `cid:${cid}:tids:votes`;
	}
	return hookData;
};

// FR-5 —— 新话题（功能建议 / Bug 反馈）推送到团队 IM 中转
Plugin.relayNewTopic = async function (payload) {
	try {
		const topic = payload && payload.topic;
		if (!topic || !topic.cid) {
			return;
		}
		const imCids = cfgList('chattodo:imCids').map(n => parseInt(n, 10));
		if (!imCids.includes(parseInt(topic.cid, 10))) {
			return;
		}
		const categoryName = await categories.getCategoryField(topic.cid, 'name');
		const body = JSON.stringify({
			tid: topic.tid,
			cid: topic.cid,
			categoryName,
			title: topic.title,
			url: `${nconf.get('url')}/topic/${topic.slug || topic.tid}`,
		});
		postJSON(IM_URL, body);
	} catch (err) {
		winston.warn('[chattodo-forum] IM 推送失败: ' + err.message);
	}
};

// FR-4.2 —— 状态标签仅 staff（管理员 / 全局版主）可打；非 staff 的状态标签在入库前被剥离
Plugin.gateStatusTagsOnCreate = async function (data) {
	return gateStatusTags(data);
};
Plugin.gateStatusTagsOnEdit = async function (data) {
	// 编辑场景 data 可能形如 { tags, ... } 或 { topic, data }；统一定位到带 tags 的对象
	if (data && data.data && Array.isArray(data.data.tags)) {
		data.data = await gateStatusTags(data.data);
		return data;
	}
	return gateStatusTags(data);
};

async function gateStatusTags(data) {
	try {
		const statusTags = cfgList('chattodo:statusTags');
		if (!statusTags.length || !data || !Array.isArray(data.tags)) {
			return data;
		}
		const uid = parseInt(data.uid, 10) || 0;
		if (await isStaff(uid)) {
			return data;
		}
		data.tags = data.tags.filter((t) => {
			const val = (t && t.value) || t;
			return !statusTags.includes(val);
		});
	} catch (err) {
		winston.warn('[chattodo-forum] 状态标签门禁失败: ' + err.message);
	}
	return data;
}

async function isStaff(uid) {
	if (!uid) {
		return false;
	}
	if (await user.isAdministrator(uid)) {
		return true;
	}
	return groups.isMember(uid, 'Global Moderators');
}

function postJSON(url, body) {
	const u = new URL(url);
	const req = http.request({
		hostname: u.hostname,
		port: u.port,
		path: u.pathname,
		method: 'POST',
		headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
	});
	req.on('error', err => winston.warn('[chattodo-forum] IM 连接失败: ' + err.message));
	req.write(body);
	req.end();
}
