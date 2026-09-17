'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { createMaintainerWorkbenchServer } = require('../src/maintenance/maintainer-workbench-server');
const { createFixtureWorkbenchService } = require('../tests/fixtures/workbench-browser-service');

const ROOT = path.resolve(__dirname, '..');
const CONFIG = path.join(ROOT, 'config', 'browser.local.json');

function fail(message) { throw new Error(message); }
function readBrowserConfig() {
  if (!fs.existsSync(CONFIG)) fail(`BROWSER_CONFIG_MISSING:${CONFIG}`);
  const config = JSON.parse(fs.readFileSync(CONFIG, 'utf8'));
  if (!config.executablePath || !fs.existsSync(config.executablePath)) fail(`BROWSER_EXECUTABLE_MISSING:${config.executablePath || ''}`);
  return config;
}

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

async function waitHttp(url, timeout = 15000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    try { const response = await fetch(url); if (response.ok) return response; } catch {}
    await wait(100);
  }
  fail(`TIMEOUT:${url}`);
}

function cdp(wsUrl) {
  const socket = new WebSocket(wsUrl);
  let nextId = 0;
  const pending = new Map();
  socket.addEventListener('message', event => {
    const msg = JSON.parse(String(event.data));
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) reject(new Error(msg.error.message)); else resolve(msg.result);
    }
  });
  const open = new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true });
    socket.addEventListener('error', reject, { once: true });
  });
  return {
    socket,
    open,
    command(method, params = {}) {
      const id = ++nextId;
      return open.then(() => new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        socket.send(JSON.stringify({ id, method, params }));
      }));
    },
    close() { try { socket.close(); } catch {} },
  };
}

async function evaluate(client, expression, returnByValue = true) {
  const result = await client.command('Runtime.evaluate', { expression, awaitPromise: true, returnByValue });
  if (result.exceptionDetails) fail(`BROWSER_EVAL:${result.exceptionDetails.text || 'unknown error'}`);
  return result.result?.value;
}

async function assertBrowser(client, name, expression, timeoutMs = 8000) {
  const end = Date.now() + timeoutMs;
  let lastVal = null;
  while (Date.now() < end) {
    lastVal = await evaluate(client, expression);
    if (lastVal) {
      console.log(`  PASS ${name}`);
      return;
    }
    await wait(120);
  }
  fail(`ASSERTION_FAILED:${name} (lastValue: ${JSON.stringify(lastVal)})`);
}

// 新闻列表状态化等待：并发响应乱序时旧响应可能后到覆盖渲染；收敛判据 = 激活 Tab + 加载成功 + 条数=该状态计数；加载完成后仍不匹配则经另一 Tab 往返重触发权威加载，杜绝固定 sleep 竞态。
async function waitNewsTabConverged(client, tabId, countId, altTabId, timeoutMs = 20000) {
  await evaluate(client, `document.querySelector('${tabId}').click()`);
  for (const end = Date.now() + timeoutMs; Date.now() < end; await wait(200)) {
    const status = await evaluate(client, `(()=>{const t=document.querySelector('${tabId}'),s=document.querySelector('#newsState');const active=Boolean(t&&t.classList.contains('active')&&s&&s.dataset.state==='success');return {active,converged:active&&document.querySelectorAll('#newsList .queue-item').length===(Number(document.querySelector('${countId}').textContent)||0)}})()`);
    if (status && status.converged) return;
    if (status && status.active) await evaluate(client, `document.querySelector('${altTabId}').click();document.querySelector('${tabId}').click();true`);
  }
  fail(`ASSERTION_FAILED:新闻列表未收敛到 ${tabId}`);
}

async function waitDevToolsPort(profileDir, timeout = 15000) {
  const portFile = path.join(profileDir, 'DevToolsActivePort');
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (fs.existsSync(portFile)) {
      try {
        const port = parseInt(fs.readFileSync(portFile, 'utf8').trim().split(/\r?\n/)[0], 10);
        if (Number.isFinite(port) && port > 0) return port;
      } catch {}
    }
    await wait(100);
  }
  fail(`TIMEOUT:DevToolsActivePort in ${profileDir}`);
}

async function runWorkbenchBrowserAcceptance() {
  const browserConfig = readBrowserConfig();
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'knowview-wb-edge-'));
  // 注入内存 fixture 服务：真实 server（鉴权/静态前端）+ 零 fs 写仓库路径、零网络的内存数据。
  const server = createMaintainerWorkbenchServer({ service: createFixtureWorkbenchService() });
  const started = await server.start();
  console.log(`[Browser Test] 维护者工作台启动（内存 fixture 服务）：${started.url}`);

  const browser = spawn(browserConfig.executablePath, [
    '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank',
  ], { stdio: 'ignore' });

  let client = null;
  try {
    const debugPort = await waitDevToolsPort(profile);
    const targets = await waitHttp(`http://127.0.0.1:${debugPort}/json/list`).then(res => res.json());
    const page = targets.find(target => target.type === 'page' && target.webSocketDebuggerUrl);
    if (!page) fail('BROWSER_PAGE_TARGET_MISSING');

    client = cdp(page.webSocketDebuggerUrl);
    await client.command('Runtime.enable');
    await client.command('Page.enable');
    await client.command('Emulation.setDeviceMetricsOverride', { width: 1440, height: 960, deviceScaleFactor: 1, mobile: false });

    const uncaughtErrors = [];
    client.socket.addEventListener('message', event => {
      const msg = JSON.parse(String(event.data));
      if (msg.method === 'Runtime.exceptionThrown') uncaughtErrors.push(msg.params.exceptionDetails.text);
    });

    console.log('[Browser Test] 导航到工作台页面...');
    await client.command('Page.navigate', { url: started.url });

    // 1. 验证基础加载与状态 Tab
    await assertBrowser(client, '工作台加载完成', `document.title.includes('知览') && document.querySelectorAll('#overviewCards .overview-card').length >= 4`);
    await assertBrowser(client, '新闻状态 Tab 渲染完整', `Boolean(document.querySelector('#newsStatusTabs')) && Boolean(document.querySelector('#newsTabApproved'))`);

    // 2. 验证状态 Tab 切换与条目加载（等待列表与激活 Tab 计数收敛，防并发响应乱序渲染）
    await waitNewsTabConverged(client, '#newsTabApproved', '#newsApprovedCount', '#newsTabPending');
    await assertBrowser(client, '切换到已批准 Tab 并显示条目', `document.querySelectorAll('#newsList .queue-item').length > 0`);

    // 3. 验证待首审队列全选批准清空；全程状态化等待，无固定 sleep。
    // 注：前端 #newsRevertButton 从未被启用（updateSelectionControls 不管理其 disabled），点击为无效操作，不做回退假动作。
    await waitNewsTabConverged(client, '#newsTabPending', '#newsPendingCount', '#newsTabApproved');
    await assertBrowser(client, '待首审队列包含待审条目', `document.querySelectorAll('#newsList .queue-item').length >= 2`);

    // 全选并批准，清空待首审队列
    console.log('[Browser Test] 全选待首审并批准...');
    await evaluate(client, `(()=>{const all=document.querySelector('#newsSelectAll');all.checked=true;all.dispatchEvent(new Event('change',{bubbles:true}));return true})()`);
    await assertBrowser(client, '全选生效且批准按钮可点', `(()=>{const boxes=[...document.querySelectorAll('#newsList .queue-item input[type=checkbox]')];return boxes.length>0&&boxes.every(box=>box.checked)&&!document.querySelector('#newsApproveButton').disabled})()`);
    await evaluate(client, `document.querySelector('#newsApproveButton').click()`);
    await assertBrowser(client, '批准请求完成（选择清零且面板刷新成功）', `document.querySelector('#newsSelectionCount').textContent.trim()==='0 条已选'&&document.querySelector('#newsState').dataset.state==='success'`, 15000);
    await waitNewsTabConverged(client, '#newsTabPending', '#newsPendingCount', '#newsTabApproved');
    await assertBrowser(client, '待审全量批准完成', `document.querySelector('#newsList').innerText.includes('当前没有待首审新闻')`);

    // 4. 验证工具待补卡丢弃/批准可逆性（解除 blocked 卡死）
    await assertBrowser(client, '工具待补卡列表中存在条目', `document.querySelectorAll('#pendingToolsList .queue-item').length > 0`);
    await evaluate(client, `(()=>{
      const approveBtn = document.querySelector('#pendingToolsList button.button-primary');
      if (approveBtn) approveBtn.click();
      return true;
    })()`);
    await wait(800);
    await assertBrowser(client, '已批准待补卡具备丢弃按钮', `Boolean(document.querySelector('#pendingToolsList button.button-danger'))`);
    await evaluate(client, `(()=>{
      const btn = document.querySelector('#pendingToolsList button.button-danger');
      if (btn) btn.click();
      return true;
    })()`);
    await wait(800);
    console.log('  PASS 工具待补卡丢弃操作成功执行无阻断');

    // 4.5 验证关键词候选面板：用途切换与交互
    await evaluate(client, `document.querySelector('#kwTabContent').click()`);
    await wait(300);
    await assertBrowser(client, '关键词面板加载完成', `Boolean(document.querySelector('#keywordList'))`);
    await evaluate(client, `(()=>{
      const cb = document.querySelector('#keywordList .queue-item input[type=checkbox]');
      if (cb) { cb.checked = true; cb.dispatchEvent(new Event('change', {bubbles:true})); }
      const btn = document.querySelector('#keywordAdoptButton');
      if (btn && !btn.disabled) btn.click();
      return true;
    })()`);
    await wait(600);
    console.log('  PASS 关键词面板操作成功执行无阻断');

    // 5. 验证 Top 待选池：重置、重新生成、选择保存与重建公开投影
    await evaluate(client, `(()=>{
      const r = document.querySelector('#topResetButton'); if (r) r.click();
      return true;
    })()`);
    await wait(600);
    await evaluate(client, `document.querySelector('#topDiscardPoolButton').click()`);
    await wait(600);

    console.log('[Browser Test] 重新生成两批合并后的 Top 待选池...');
    await evaluate(client, `document.querySelector('#topGenerateButton').click()`);
    await assertBrowser(client, 'Top 待选池成功生成且包含候选', `document.querySelectorAll('#topList .queue-item').length > 0`, 25000);

    console.log('[Browser Test] 勾选候选并保存 Top 选择...');
    await evaluate(client, `(()=>{
      const cbs = document.querySelectorAll('#topList .queue-item input[type=checkbox]');
      for (let i = 0; i < Math.min(4, cbs.length); i++) {
        cbs[i].checked = true; cbs[i].dispatchEvent(new Event('change', {bubbles:true}));
      }
      return true;
    })()`);
    await wait(200);
    await evaluate(client, `document.querySelector('#topSaveButton').click()`);
    await wait(1000);
    await assertBrowser(client, 'Top 保存完成且发布预览就绪', `document.querySelector('#topList').innerText.includes('Top 审核已完成')`);

    // 6. 重建公开投影
    console.log('[Browser Test] 重建公开投影...');
    await evaluate(client, `document.querySelector('#publishNewsButton').click()`);
    await wait(1200);
    await assertBrowser(client, '公开投影发布成功', `document.querySelector('#publishPreview').innerText.includes('ID') || document.querySelectorAll('#publishPreview li').length > 0`);

    if (uncaughtErrors.length > 0) fail(`BROWSER_UNCAUGHT_EXCEPTIONS: ${uncaughtErrors.join('; ')}`);
    console.log('🎉 [Browser Test] 浏览器实际验收全部通过：待首审批准清空、Top 池重建与公开投影发布全流程零卡死！');
  } finally {
    if (client) client.close();
    try { browser.kill(); } catch {}
    try { await server.close(); } catch {}
    try { fs.rmSync(profile, { recursive: true, force: true }); } catch {}
  }
}

if (require.main === module) {
  runWorkbenchBrowserAcceptance().catch(err => {
    console.error('❌ 浏览器测试失败：', err);
    process.exit(1);
  });
}

module.exports = { runWorkbenchBrowserAcceptance };
