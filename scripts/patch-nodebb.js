'use strict';

/*
 * 对 vendored NodeBB 施加沙箱环境所需的核心补丁（幂等）。
 * nodebb/ 目录不入库，新克隆后由 install.sh 调用本脚本重放补丁。
 *
 * 补丁 1：src/meta/languages.js —— 构建语言包时并发打开约 4000 个文件会触发 EMFILE
 *         （容器 fd 上限 4096 且不可调高）。改为分批并发（每批 40）。
 */

const fs = require('fs');
const path = require('path');

const NBB = path.resolve(__dirname, '../nodebb');
const langFile = path.join(NBB, 'src/meta/languages.js');

const ORIGINAL = `	const promises = [];

	namespaces.forEach((namespace) => {
		languages.forEach((language) => {
			promises.push(buildNamespaceLanguage(language, namespace, plugins));
		});
	});

	await Promise.all(promises);
}`;

const PATCHED = `	const tasks = [];

	namespaces.forEach((namespace) => {
		languages.forEach((language) => {
			tasks.push(() => buildNamespaceLanguage(language, namespace, plugins));
		});
	});

	// Cap concurrency to avoid EMFILE (too many open files) in fd-constrained
	// environments — the language matrix can be ~4000 combinations, each opening files.
	const concurrency = 40;
	for (let i = 0; i < tasks.length; i += concurrency) {
		// eslint-disable-next-line no-await-in-loop
		await Promise.all(tasks.slice(i, i + concurrency).map(fn => fn()));
	}
}`;

function main() {
	// Windows 检出时 NodeBB 源文件可能是 CRLF，而本文件的匹配串是 LF，
	// 先把行尾归一为 LF 再匹配/替换，避免跨平台行尾差异导致补丁失配。
	let src = fs.readFileSync(langFile, 'utf8').replace(/\r\n/g, '\n');
	if (src.includes('Cap concurrency to avoid EMFILE')) {
		console.log('[patch] languages.js 已打补丁，跳过');
		return;
	}
	if (!src.includes(ORIGINAL)) {
		console.error('[patch] 未找到 languages.js 目标代码块（NodeBB 版本可能不匹配）。请手动核对。');
		process.exit(1);
	}
	src = src.replace(ORIGINAL, PATCHED);
	fs.writeFileSync(langFile, src);
	console.log('[patch] languages.js 已打补丁（EMFILE 分批并发）');
}

main();
