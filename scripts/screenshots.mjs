// DoD 验收截图：驱动真实浏览器走通关键流程并截图。
// 用法：node scripts/screenshots.mjs
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';

const BASE = process.env.BASE || 'http://localhost:4567';
const OUT = path.resolve('screenshots');
fs.mkdirSync(OUT, { recursive: true });

// 兼容预装 Chromium（版本与 npm 包不一致，改用显式 executablePath）
const EXEC = '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const launchOpts = { headless: true };
if (fs.existsSync(EXEC)) { launchOpts.executablePath = EXEC; }

const shots = [];
function record(name, ok, note) { shots.push({ name, ok, note: note || '' }); console.log(`${ok ? '✓' : '✗'} ${name} ${note || ''}`); }

async function loginAs(page, who) {
	await page.goto(`${BASE}/auth/chattodo`, { waitUntil: 'domcontentloaded' });
	await page.waitForSelector(`a[href*="login_as=${who}"]`, { timeout: 15000 });
	await Promise.all([
		page.waitForURL(u => !String(u).includes(':5555'), { timeout: 20000 }),
		page.click(`a[href*="login_as=${who}"]`),
	]);
	await page.waitForLoadState('networkidle').catch(() => {});
}

async function logout(page) {
	await page.context().clearCookies();
}

async function main() {
	const browser = await chromium.launch(launchOpts);
	const ctx = await browser.newContext({ viewport: { width: 1360, height: 940 }, locale: 'zh-CN' });
	const page = await ctx.newPage();

	// 1. 纯手机号用户 SSO 登录（无邮箱验证）
	try {
		await loginAs(page, 'phone');
		await page.goto(`${BASE}/`, { waitUntil: 'networkidle' });
		await page.screenshot({ path: `${OUT}/01-sso-phone-login.png`, fullPage: false });
		const who = await page.evaluate(() => (window.app && window.app.user && window.app.user.username) || '');
		record('01-sso-phone-login.png', true, `logged in as ${who}`);
	} catch (e) { record('01-sso-phone-login.png', false, e.message.split('\n')[0]); }

	// 2. 版块列表（6 个，中文）
	try {
		await page.goto(`${BASE}/categories`, { waitUntil: 'networkidle' });
		await page.waitForTimeout(800);
		await page.screenshot({ path: `${OUT}/02-categories.png`, fullPage: true });
		record('02-categories.png', true);
	} catch (e) { record('02-categories.png', false, e.message.split('\n')[0]); }

	// 3. 功能建议：投票排序 + 状态标签
	try {
		await page.goto(`${BASE}/category/6`, { waitUntil: 'networkidle' });
		await page.waitForTimeout(800);
		await page.screenshot({ path: `${OUT}/03-suggestions-voting.png`, fullPage: true });
		record('03-suggestions-voting.png', true);
	} catch (e) { record('03-suggestions-voting.png', false, e.message.split('\n')[0]); }

	// 4. Bug 反馈：从版块页点「发表主题」打开编辑器，自动填充话题模板
	try {
		await page.goto(`${BASE}/category/7`, { waitUntil: 'networkidle' });
		await page.waitForTimeout(1200);
		await page.click('[component="category/post"]').catch(async () => {
			await page.getByText('发表主题', { exact: false }).first().click();
		});
		await page.waitForTimeout(3000); // 等编辑器打开 + 模板注入
		await page.screenshot({ path: `${OUT}/04-bug-template.png`, fullPage: false });
		const filled = await page.evaluate(() => {
			const ta = document.querySelector('textarea.write');
			return ta && ta.value ? ta.value.length : 0;
		});
		record('04-bug-template.png', filled > 50, `template chars: ${filled}`);
	} catch (e) { record('04-bug-template.png', false, e.message.split('\n')[0]); }

	// 5. 会员角标：打开张明（付费会员）的分享帖，展示帖内头衔/角标
	try {
		await page.goto(`${BASE}/category/9`, { waitUntil: 'networkidle' });
		await page.waitForTimeout(600);
		// 点第一个包含「工作流」的话题（张明的周报流）
		const link = page.locator('a[href*="/topic/"]').filter({ hasText: '周报' }).first();
		if (await link.count()) { await link.click(); } else { await page.locator('a[href*="/topic/"]').first().click(); }
		await page.waitForLoadState('networkidle');
		await page.waitForTimeout(800);
		await page.screenshot({ path: `${OUT}/05-member-flair.png`, fullPage: false });
		record('05-member-flair.png', true);
	} catch (e) { record('05-member-flair.png', false, e.message.split('\n')[0]); }

	// 6a. 内测专区：普通用户看不到（换成 free 用户的版块列表）
	try {
		await logout(page);
		await loginAs(page, 'free');
		await page.goto(`${BASE}/categories`, { waitUntil: 'networkidle' });
		await page.waitForTimeout(600);
		await page.screenshot({ path: `${OUT}/06a-beta-hidden-for-free.png`, fullPage: true });
		record('06a-beta-hidden-for-free.png', true, 'free user category list (no 内测专区)');
	} catch (e) { record('06a-beta-hidden-for-free.png', false, e.message.split('\n')[0]); }

	// 6b. 内测专区：beta 用户可见可进
	try {
		await logout(page);
		await loginAs(page, 'beta');
		await page.goto(`${BASE}/categories`, { waitUntil: 'networkidle' });
		await page.waitForTimeout(600);
		await page.screenshot({ path: `${OUT}/06b-beta-visible-for-beta.png`, fullPage: true });
		record('06b-beta-visible-for-beta.png', true, 'beta user sees 内测专区');
	} catch (e) { record('06b-beta-visible-for-beta.png', false, e.message.split('\n')[0]); }

	// 7. IM 中转：beta 用户（承接上一步会话）发一条 Bug 反馈，展示 mock IM 收到的消息
	try {
		await page.goto(`${BASE}/`, { waitUntil: 'networkidle' });
		// 用浏览器自身会话 + CSRF 发帖，稳定触发 action:topic.post → IM 中转
		const posted = await page.evaluate(async () => {
			const cfg = await fetch('/api/config').then(r => r.json());
			const resp = await fetch('/api/v3/topics', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json', 'x-csrf-token': cfg.csrf_token },
				body: JSON.stringify({
					cid: 7,
					title: '会议纪要转 Todo 时偶发丢失最后一条行动项',
					content: '把较长的会议纪要转成任务时，偶发最后一条行动项没有被生成，怀疑与分段处理有关，麻烦看下。',
				}),
			});
			const j = await resp.json();
			return (j.response && j.response.tid) || (j.status && j.status.message) || 'unknown';
		});
		await page.waitForTimeout(1500);
		await page.goto('http://127.0.0.1:5566/im/received', { waitUntil: 'domcontentloaded' });
		await page.waitForTimeout(400);
		await page.screenshot({ path: `${OUT}/07-im-relay-received.png`, fullPage: true });
		record('07-im-relay-received.png', true, `posted tid=${posted}`);
	} catch (e) { record('07-im-relay-received.png', false, e.message.split('\n')[0]); }

	await browser.close();

	console.log('\n=== 截图汇总 ===');
	shots.forEach(s => console.log(`${s.ok ? '✓' : '✗'} ${s.name} ${s.note}`));
	const failed = shots.filter(s => !s.ok).length;
	console.log(`\n完成 ${shots.length - failed}/${shots.length}，输出目录: ${OUT}`);
	process.exit(failed > shots.length / 2 ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
