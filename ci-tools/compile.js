#!/usr/bin/env node
/**
 * compile.js — SecLog 小程序 miniprogram-ci 工具链
 *
 * 用法：
 *   node compile.js dev-check   项目内文件静态检查（不需密钥）
 *   node compile.js preview      生成预览二维码（需密钥）
 *   node compile.js upload       上传代码到微信后台（需密钥）
 *
 * 方案 A2：上传前用 babel 把 miniprogram/ 转译成 ES2019 兼容副本（.build/miniprogram/），
 * 再让 miniprogram-ci 上传副本。源码 miniprogram/ 不动，CI 上传绕开微信后台
 * 老 parser 不认可选链（?.）的限制。
 */

'use strict';

const path = require('path');
const fs = require('fs');
const ci = require('miniprogram-ci');

try {
  require('dotenv').config({ path: path.join(__dirname, '.env') });
} catch (_) {}

const cmd = process.argv[2];
const projectRoot = path.resolve(__dirname, '..');
const miniRoot = path.join(projectRoot, 'miniprogram');
const buildDir = path.join(__dirname, '.build', 'miniprogram');

function die(msg, code = 1) {
  console.error(`\n❌ ${msg}\n`);
  process.exit(code);
}

// ===== babel 转译（方案 A2）=====
let babel = null;
let BABEL_PLUGINS = null;
try {
  babel = require('@babel/core');
  // 直接 require 插件对象，避免 babel 内部按字符串名解析模块时受 miniprogram-ci 依赖树干扰
  BABEL_PLUGINS = [
    require('@babel/plugin-transform-optional-chaining'),
    require('@babel/plugin-transform-nullish-coalescing-operator'),
  ];
} catch (_) {}

function transpileProject() {
  if (!babel) {
    die('未安装 @babel/core，无法做上传前转译。\n请先: npm install -D @babel/core @babel/plugin-transform-optional-chaining @babel/plugin-transform-nullish-coalescing-operator');
  }
  console.log('  🔧 转译 miniprogram/ → .build/miniprogram/（?. 和 ?? → ES2019 兼容）');
  if (fs.existsSync(buildDir)) fs.rmSync(buildDir, { recursive: true, force: true });
  fs.mkdirSync(buildDir, { recursive: true });

  function walk(src) {
    for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
      const absSrc = path.join(src, entry.name);
      const rel = path.relative(miniRoot, absSrc);
      const absDest = path.join(buildDir, rel);
      if (entry.isDirectory()) {
        fs.mkdirSync(absDest, { recursive: true });
        walk(absSrc);
      } else if (entry.isFile()) {
        fs.mkdirSync(path.dirname(absDest), { recursive: true });
        if (path.extname(entry.name) === '.js') {
          const code = fs.readFileSync(absSrc, 'utf-8');
          const result = babel.transformSync(code, {
            filename: entry.name,
            plugins: BABEL_PLUGINS,
            babelrc: false,
            configFile: false,
          });
          fs.writeFileSync(absDest, result.code);
        } else {
          fs.copyFileSync(absSrc, absDest);
        }
      }
    }
  }
  walk(miniRoot);
  console.log('  ✅ 转译完成（副本在 ' + buildDir + '）');
}

// ===== dev-check =====
async function devCheck() {
  console.log('🔍 dev-check: 静态扫描 miniprogram/ 文件结构\n');
  const errors = [];

  for (const f of ['app.js', 'app.json', 'app.wxss']) {
    const fp = path.join(miniRoot, f);
    if (!fs.existsSync(fp)) {
      errors.push(`缺少入口文件: miniprogram/${f}`);
    } else {
      const stat = fs.statSync(fp);
      console.log(`  📄 miniprogram/${f}  (${stat.size} B)`);
      if (stat.size === 0 && f !== 'app.wxss') {
        errors.push(`miniprogram/${f} 是空文件`);
      }
    }
  }

  const pagesDir = path.join(miniRoot, 'pages');
  let pages = [];
  if (fs.existsSync(pagesDir)) {
    pages = fs.readdirSync(pagesDir, { withFileTypes: true })
      .filter(d => d.isDirectory())
      .map(d => d.name);
  } else {
    console.log('  ⚠️  miniprogram/pages/ 不存在');
  }
  console.log(`  📂 页面目录: pages/${pages.join(', ') || '(无)'}`);

  for (const p of pages) {
    for (const f of [`${p}.js`, `${p}.json`, `${p}.wxml`, `${p}.wxss`]) {
      const fp = path.join(pagesDir, p, f);
      if (!fs.existsSync(fp)) errors.push(`页面 pages/${p} 缺文件: ${f}`);
    }
  }

  const componentsDir = path.join(miniRoot, 'components');
  let componentCount = 0;
  if (fs.existsSync(componentsDir)) {
    componentCount = fs.readdirSync(componentsDir, { withFileTypes: true })
      .filter(d => d.isDirectory()).length;
  }
  console.log(`  🧩 组件目录: components/  (${componentCount} 个)`);

  let consoleCount = 0;
  let todoCount = 0;
  function walk(dir) {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const fp = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules') continue;
        walk(fp);
      } else if (/\.(js|ts)$/.test(entry.name)) {
        const content = fs.readFileSync(fp, 'utf-8');
        const lines = content.split('\n');
        lines.forEach((line) => {
          if (/\bconsole\.(log|debug|info|warn)\b/.test(line)) consoleCount++;
          if (/\bTODO\b/.test(line)) todoCount++;
        });
      }
    }
  }
  walk(miniRoot);
  console.log(`  🔎 console.* 使用: ${consoleCount} 处`);
  console.log(`  📝 TODO 注释:     ${todoCount} 处`);

  console.log('');
  if (errors.length) {
    console.error('❌ dev-check 失败:');
    for (const e of errors) console.error(`  - ${e}`);
    process.exit(1);
  }
  console.log('✅ dev-check 通过（仅文件结构层面）');
  console.log('   ⚠️  这不替代微信开发者工具的 WXML/WXSS 编译与运行时检查');
}

// ===== loadProject（方案 A2：先转译，再指向 .build 副本）=====
function loadProject() {
  const appid = process.env.APPID;
  const projectPath = process.env.PROJECT_PATH;
  const privateKeyPath = process.env.PRIVATE_KEY_PATH;
  const robot = parseInt(process.env.ROBOT || '1', 10);
  const version = process.env.VERSION || '0.0.1';
  const desc = process.env.DESC || 'local build from seclog-ci';

  if (!appid) die('APPID 未设置（请在 .env 中配置）');
  if (!projectPath) die('PROJECT_PATH 未设置');
  if (!privateKeyPath) die('PRIVATE_KEY_PATH 未设置');

  const absKey = path.resolve(__dirname, privateKeyPath);
  if (!fs.existsSync(absKey)) {
    die(`找不到密钥文件: ${absKey}\n请确认私钥已放到此路径，或修改 .env 的 PRIVATE_KEY_PATH`);
  }

  const absProject = path.resolve(__dirname, projectPath);
  if (!fs.existsSync(absProject)) die(`找不到小程序目录: ${absProject}`);

  // 方案 A2：先转译到 .build，再上传 .build 副本（源码不动）
  transpileProject();

  const project = new ci.Project({
    appid,
    type: 'miniProgram',
    projectPath: buildDir,
    privateKey: fs.readFileSync(absKey),
    ignores: ['node_modules/**', '.git/**'],
  });

  return { project, robot, version, desc };
}

async function preview() {
  console.log('📷 preview: 生成预览二维码\n');
  const { project, robot, version, desc } = loadProject();

  const qrFilename = `qrcode-${new Date().toISOString().replace(/[:.]/g, '-')}.png`;
  const qrPath = path.join(__dirname, qrFilename);

  try {
    await ci.preview({
      project,
      version,
      desc,
      robot,
      qrcodeFormat: 'image',
      qrcodeOutputDest: qrPath,
      onProgressUpdate: (msg) => console.log(`  [progress] ${msg}`),
    });
  } catch (e) {
    die(`preview 失败: ${e.message || e}`);
  }
  console.log(`\n✅ 二维码已保存: ${qrPath}`);
  console.log(`   用「微信开发者工具」或微信扫码可打开预览`);
}

async function upload() {
  console.log('🚀 upload: 上传代码到微信后台（体验版）\n');
  const { project, robot, version, desc } = loadProject();

  try {
    await ci.upload({
      project,
      version,
      desc,
      robot,
      onProgressUpdate: (msg) => console.log(`  [progress] ${msg}`),
    });
  } catch (e) {
    die(`upload 失败: ${e.message || e}`);
  }
  console.log('\n✅ 上传完成，可在微信公众平台 → 版本管理查看');
}

// ===== 路由 =====
(async () => {
  const cmdName = cmd || '(未指定)';
  console.log(`\n  SecLog miniprogram-ci  ·  ${cmdName}\n`);

  try {
    switch (cmd) {
      case 'dev-check': await devCheck(); break;
      case 'preview':   await preview(); break;
      case 'upload':    await upload(); break;
      default:
        console.log('用法: node compile.js <dev-check|preview|upload>');
        process.exit(1);
    }
  } catch (e) {
    die(e.message || String(e));
  }
})();
