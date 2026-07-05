'use strict';

/*
 * Mock 团队 IM 中转 —— 对应 PRD FR-5 的「约 50 行中转函数」。
 *
 * Discourse/NodeBB 的 Webhook 把新话题 POST 到这里，adapt() 把它转成
 * 飞书/钉钉/企业微信/Slack 同构的文本机器人消息格式（实施时换 webhook 地址即可，方案不变）。
 *
 *   POST /im/webhook   接收论坛推送的话题 JSON，适配并暂存
 *   GET  /im/received  返回已收到的全部消息（供验证/截图）
 */

const express = require('express');

const app = express();
app.use(express.json());

const PORT = parseInt(process.env.IM_PORT || '5566', 10);
const HOST = '127.0.0.1';
const received = [];

// 把论坛话题适配为「群机器人」文本消息（飞书/钉钉/企微/Slack 同构）
function adapt(topic) {
	const cat = topic.categoryName || '反馈';
	const content = `【新${cat}】${topic.title || '(无标题)'}\n${topic.url || ''}`;
	return { msgtype: 'text', text: { content } };
}

app.post('/im/webhook', (req, res) => {
	const message = adapt(req.body || {});
	const entry = { at: new Date().toISOString(), source: req.body, message };
	received.push(entry);
	// eslint-disable-next-line no-console
	console.log('[mock-im] 收到 ->', message.text.content.replace(/\n/g, '  '));
	res.json({ ok: true, message });
});

app.get('/im/received', (req, res) => res.json({ count: received.length, items: received }));
app.get('/_health', (req, res) => res.json({ ok: true, service: 'mock-im', count: received.length }));

app.listen(PORT, HOST, () => {
	// eslint-disable-next-line no-console
	console.log(`[mock-im] 团队 IM 中转 on http://${HOST}:${PORT}`);
});
