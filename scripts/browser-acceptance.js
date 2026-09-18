'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const DIST = path.join(ROOT, 'dist');
const CONFIG = path.join(ROOT, 'config', 'browser.local.json');
const PORT = 4173;
const DESKTOP_SCREENSHOT = path.join(os.tmpdir(), 'knowview-compare-desktop.png');
const MOBILE_SCREENSHOT = path.join(os.tmpdir(), 'knowview-compare-mobile.png');

function fail(message) { throw new Error(message); }
function readConfig() {
  if (!fs.existsSync(CONFIG)) fail(`BROWSER_CONFIG_MISSING:${CONFIG}`);
  const config = JSON.parse(fs.readFileSync(CONFIG, 'utf8'));
  if (!config.executablePath || !fs.existsSync(config.executablePath)) fail(`BROWSER_EXECUTABLE_MISSING:${config.executablePath || ''}`);
  return config;
}
function wait(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }
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
    const message = JSON.parse(String(event.data));
    if (message.id && pending.has(message.id)) {
      const { resolve, reject } = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) reject(new Error(message.error.message)); else resolve(message.result);
    }
  });
  const open = new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true });
    socket.addEventListener('error', reject, { once: true });
  });
  return { socket, open, command(method, params = {}) { const id = ++nextId; return open.then(() => new Promise((resolve, reject) => { pending.set(id, { resolve, reject }); socket.send(JSON.stringify({ id, method, params })); })); } };
}
async function evaluate(client, expression, returnByValue = true) {
  const result = await client.command('Runtime.evaluate', { expression, awaitPromise: true, returnByValue });
  if (result.exceptionDetails) fail(`BROWSER_EVAL:${result.exceptionDetails.text || 'unknown error'}`);
  return result.result?.value;
}
async function dispatchMouseEvent(client, type, x, y, buttons = 0) {
  await client.command('Input.dispatchMouseEvent', { type, x, y, button: 'left', buttons, clickCount: type === 'mousePressed' ? 1 : 0 });
}
async function dispatchKey(client, key, code, keyCode) {
  await client.command('Input.dispatchKeyEvent', { type: 'keyDown', key, code, windowsVirtualKeyCode: keyCode, nativeVirtualKeyCode: keyCode });
  await client.command('Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode: keyCode, nativeVirtualKeyCode: keyCode });
}
async function captureScreenshot(client, filename) {
  const result = await client.command('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(filename, Buffer.from(result.data, 'base64'));
}
async function waitFrames(client, count = 2) {
  await evaluate(client, `(async()=>{for(let i=0;i<${count};i++)await new Promise(requestAnimationFrame);return true})()`);
}
async function assertNear(name, actual, expected, tolerance = 2) {
  if (!Number.isFinite(actual) || Math.abs(actual - expected) > tolerance) fail(`ASSERTION_FAILED:${name} actual=${actual} expected=${expected} tolerance=${tolerance}`);
  console.log(`  PASS ${name}`);
}
async function assertBrowser(client, name, expression) {
  const value = await evaluate(client, expression);
  if (!value) fail(`ASSERTION_FAILED:${name}`);
  console.log(`  PASS ${name}`);
}
async function waitDevToolsPort(profileDir, timeout = 15000) {
  const portFile = path.join(profileDir, 'DevToolsActivePort');
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (fs.existsSync(portFile)) {
      try {
        const content = fs.readFileSync(portFile, 'utf8').trim().split(/\r?\n/);
        const port = parseInt(content[0], 10);
        if (Number.isFinite(port) && port > 0) return port;
      } catch {}
    }
    await wait(100);
  }
  fail(`TIMEOUT:DevToolsActivePort in ${profileDir}`);
}
async function main() {
  const config = readConfig();
  if (!fs.existsSync(DIST)) fail(`DIST_MISSING:${DIST}`);
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'knowview-edge-'));
  const serverCode = "import http.server, os; os.chdir('dist'); Handler=type('Handler',(http.server.SimpleHTTPRequestHandler,),{'extensions_map':{**http.server.SimpleHTTPRequestHandler.extensions_map,'.mjs':'text/javascript'}}); http.server.ThreadingHTTPServer(('127.0.0.1'," + PORT + "),Handler).serve_forever()";
  const server = spawn(process.platform === 'win32' ? 'python' : 'python3', ['-c', serverCode], { cwd: ROOT, stdio: 'ignore' });
  const browser = spawn(config.executablePath, [`--headless=new`, `--disable-gpu`, `--no-first-run`, `--no-default-browser-check`, `--remote-debugging-port=0`, `--user-data-dir=${profile}`, 'about:blank'], { stdio: 'ignore' });
  let client;
  try {
    await waitHttp(`http://127.0.0.1:${PORT}/`);
    const debugPort = await waitDevToolsPort(profile);
    const targets = await waitHttp(`http://127.0.0.1:${debugPort}/json/list`).then(response => response.json());
    const page = targets.find(target => target.type === 'page' && target.webSocketDebuggerUrl);
    if (!page) fail('BROWSER_PAGE_TARGET_MISSING');
    client = cdp(page.webSocketDebuggerUrl);
    await client.command('Runtime.enable');
    await client.command('Page.enable');
    await client.command('Emulation.setDeviceMetricsOverride', { width: 1366, height: 900, deviceScaleFactor: 1, mobile: false });
    const consoleErrors = [];
    client.socket.addEventListener('message', event => {
      const message = JSON.parse(String(event.data));
      if (message.method === 'Runtime.consoleAPICalled' && ['error', 'assert'].includes(message.params.type)) consoleErrors.push(message.params.type);
    });
    await client.command('Page.navigate', { url: `http://127.0.0.1:${PORT}/` });
    const readyEnd = Date.now() + 15000;
    while (Date.now() < readyEnd && !(await evaluate(client, `document.querySelector('#app')?.getAttribute('aria-busy') === 'false'`))) await wait(100);
    await assertBrowser(client, '页面数据加载', `document.querySelector('#app')?.getAttribute('aria-busy') === 'false'`);
    await assertBrowser(client, '首页加载', `document.title.includes('知览')||document.title.includes('KnowView')`);
    await assertBrowser(client, '工具库导航', `(()=>{document.querySelector('[data-view="tools"]').click();return document.querySelector('#view-tools').classList.contains('active')})()`);
    await wait(300);
    await assertBrowser(client, '工具视图切换', `(()=>{const t=document.querySelector('#toolsViewToggle');if(t.getAttribute('aria-checked')!=='true')t.click();return t.getAttribute('aria-checked')==='true'})()`);
    await wait(300);
    // 动态取样：页面内 fetch data/catalog/tool-cards.json，与当前可见卡片名求交集后逐一搜索命中。
    const sampleTargets = await evaluate(client, `(async()=>{const payload=await fetch('data/catalog/tool-cards.json').then(r=>r.json());const cards=Array.isArray(payload&&payload.items)?payload.items:[];const visible=[...document.querySelectorAll('#toolDirectoryView .tool-card-name')].map(x=>x.textContent.trim());const titles=cards.map(c=>String(c.title||'')).filter(t=>t&&visible.some(v=>v===t||v.startsWith(t)));const step=Math.max(1,Math.ceil(titles.length/15));return titles.filter((_,i)=>i%step===0).slice(0,15)})()`);
    if (!Array.isArray(sampleTargets) || sampleTargets.length < 5) fail(`ASSERTION_FAILED:动态模型卡样本不足:${JSON.stringify(sampleTargets)}`);
    // 动态日期取样必须在搜索循环之前（目录全量未过滤窗口）完成：搜索循环结束后 input 残留卡名、
    // 目录处于过滤态，可见池塌缩会导致 tool 类取样失败。选一个带 release_date、一个带 last_updated_date
    // 的详情，断言 typed 标签「发布日期/最近更新」（对照 src/web/js/ui/date-display.mjs 的 detail_kind 规则）。
    const datePicks = await evaluate(client, `(async()=>{const isDate=v=>/^\\d{4}-\\d{2}-\\d{2}$/.test(String(v||''))&&!Number.isNaN(Date.parse(v+'T00:00:00Z'));const cards=await fetch('data/catalog/tool-cards.json').then(r=>r.json()).then(p=>(p&&Array.isArray(p.items))?p.items:[]);const details=await fetch('data/catalog/tool-preview-level3.json').then(r=>r.json()).then(p=>(p&&Array.isArray(p.items))?p.items:[]);const byId=new Map(details.map(d=>[d.id,d]));const visible=[...document.querySelectorAll('#toolDirectoryView .tool-card-name')].map(x=>x.textContent.trim());const pick=kinds=>{for(const card of cards){const detail=byId.get(card.detail_ref&&card.detail_ref.id);if(!detail||!kinds.includes(detail.detail_kind))continue;if(!Array.isArray(detail.sources)||!detail.sources.length)continue;if(!visible.some(v=>v===card.title||v.startsWith(card.title)))continue;const value=kinds[0]==='tool'?detail.last_updated_date:detail.release_date;if(!isDate(value))continue;return {title:String(card.title||''),label:kinds[0]==='tool'?'最近更新':'发布日期',value};}return null;};return {updated:pick(['tool']),release:pick(['api_model'])||pick(['product_variant'])};})()`);
    for (const target of sampleTargets) {
      await assertBrowser(client, `模型卡可搜索：${target}`, `(()=>{const input=document.querySelector('#searchInput');input.value=${JSON.stringify(target)};input.dispatchEvent(new Event('input',{bubbles:true}));return new Promise(resolve=>setTimeout(()=>resolve(document.querySelector('#toolDirectoryView').innerText.includes(${JSON.stringify(target)})),250))})()`);
    }
    console.log(`  PASS 模型卡动态取样逐一可搜索（${sampleTargets.length} 张）`);
    for (const [pickName, pick] of [['发布日期', datePicks && datePicks.release], ['最近更新', datePicks && datePicks.updated]]) {
      if (!pick) fail(`ASSERTION_FAILED:动态${pickName}详情取样失败:${JSON.stringify(datePicks)}`);
      const expectedText = `${pick.label} ${pick.value}`;
      await assertBrowser(client, `${pickName} typed 标签正确：${pick.title}`, `(async()=>{const input=document.querySelector('#searchInput');input.value=${JSON.stringify(pick.title)};input.dispatchEvent(new Event('input',{bubbles:true}));await new Promise(resolve=>setTimeout(resolve,250));const name=[...document.querySelectorAll('.tool-card-name')].find(x=>x.textContent.trim().startsWith(${JSON.stringify(pick.title)}));const card=name&&name.closest('.tool-card');if(!card)return false;card.click();await new Promise(resolve=>setTimeout(resolve,100));const valid=document.querySelector('#modalContent').innerText.includes(${JSON.stringify(expectedText)});window.closeModal();return valid})()`);
    }
    await assertBrowser(client, 'Qwen 详情可打开', `(async()=>{const input=document.querySelector('#searchInput');input.value='Qwen3.8 Max';input.dispatchEvent(new Event('input',{bubbles:true}));await new Promise(resolve=>setTimeout(resolve,250));const card=[...document.querySelectorAll('.tool-card')].find(x=>x.innerText.includes('Qwen3.8 Max'));if(!card)return false;card.click();await new Promise(resolve=>setTimeout(resolve,100));return !document.querySelector('#modalOverlay').hidden})()`);
    await evaluate(client, `window.closeModal?.();true`);
    await assertBrowser(client, '旧 Spark 与 xunfei 不出现', `!document.body.innerText.includes('Spark 4.0 Ultra')&&!document.body.innerText.includes('Spark Pro')&&!document.body.innerText.includes('Spark Lite')&&!document.body.innerText.includes('Spark X2')`);
    await assertBrowser(client, '对比页加载', `(()=>{document.querySelector('[data-view="compare"]').click();return document.querySelector('#view-compare').classList.contains('active')})()`);
    await wait(500);
    const initialLayout = await evaluate(client, `(()=>{const layout=document.querySelector('.cmp-layout'),splitter=document.querySelector('#cmpSplitter'),selector=document.querySelector('.cmp-selector'),main=document.querySelector('.cmp-main');if(!layout||!splitter||!selector||!main)return null;const rect=splitter.getBoundingClientRect();return {selectorWidth:selector.getBoundingClientRect().width,mainLeft:main.getBoundingClientRect().left,splitter:{left:rect.left,top:rect.top,width:rect.width,height:rect.height},ariaNow:Number(splitter.getAttribute('aria-valuenow')),ariaMin:Number(splitter.getAttribute('aria-valuemin')),ariaMax:Number(splitter.getAttribute('aria-valuemax'))}})()`);
    if (!initialLayout || initialLayout.splitter.width <= 0) fail('ASSERTION_FAILED:模型对比分隔条可见');
    await captureScreenshot(client, DESKTOP_SCREENSHOT);
    console.log(`  PASS 桌面端视觉截图 ${DESKTOP_SCREENSHOT}`);
    await assertNear('分隔条默认左栏宽度同步', initialLayout.selectorWidth, initialLayout.ariaNow, 2);
    if (initialLayout.ariaMin >= initialLayout.ariaMax) fail('ASSERTION_FAILED:分隔条宽度边界有效');
    console.log('  PASS 分隔条宽度边界有效');
    const dragSplitter = async (from, to) => {
      const y = from.top + Math.min(from.height / 2, 120);
      await dispatchMouseEvent(client, 'mousePressed', from.left + from.width / 2, y, 1);
      await dispatchMouseEvent(client, 'mouseMoved', to, y, 1);
      await dispatchMouseEvent(client, 'mouseReleased', to, y, 0);
      await waitFrames(client, 1);
    };
    await dragSplitter(initialLayout.splitter, initialLayout.splitter.left + initialLayout.splitter.width / 2 + 100);
    const widenedLayout = await evaluate(client, `(()=>{const selector=document.querySelector('.cmp-selector'),main=document.querySelector('.cmp-main'),splitter=document.querySelector('#cmpSplitter');const rect=splitter.getBoundingClientRect();return {selectorWidth:selector.getBoundingClientRect().width,mainLeft:main.getBoundingClientRect().left,splitter:{left:rect.left,top:rect.top,width:rect.width,height:rect.height},ariaNow:Number(splitter.getAttribute('aria-valuenow'))}})()`);
    if (widenedLayout.selectorWidth <= initialLayout.selectorWidth + 50 || widenedLayout.mainLeft <= initialLayout.mainLeft + 50) fail('ASSERTION_FAILED:向右拖拽调整左右栏宽度');
    console.log('  PASS 向右拖拽调整左右栏宽度');
    await dragSplitter(widenedLayout.splitter, widenedLayout.splitter.left + widenedLayout.splitter.width / 2 - 100);
    const restoredLayout = await evaluate(client, `(()=>{const selector=document.querySelector('.cmp-selector'),splitter=document.querySelector('#cmpSplitter');return {selectorWidth:selector.getBoundingClientRect().width,ariaNow:Number(splitter.getAttribute('aria-valuenow'))}})()`);
    if (restoredLayout.selectorWidth >= widenedLayout.selectorWidth - 50) fail('ASSERTION_FAILED:向左拖拽调整左右栏宽度');
    console.log('  PASS 向左拖拽调整左右栏宽度');
    const currentSplitter = await evaluate(client, `(()=>{const rect=document.querySelector('#cmpSplitter').getBoundingClientRect();return {left:rect.left,top:rect.top,width:rect.width,height:rect.height}})()`);
    await dragSplitter(currentSplitter, 2000);
    const maxLayout = await evaluate(client, `(()=>{const selector=document.querySelector('.cmp-selector'),splitter=document.querySelector('#cmpSplitter');return {selectorWidth:selector.getBoundingClientRect().width,ariaMax:Number(splitter.getAttribute('aria-valuemax'))}})()`);
    await assertNear('拖拽最大宽度边界', maxLayout.selectorWidth, maxLayout.ariaMax, 2);
    const maxSplitter = await evaluate(client, `(()=>{const rect=document.querySelector('#cmpSplitter').getBoundingClientRect();return {left:rect.left,top:rect.top,width:rect.width,height:rect.height}})()`);
    await dragSplitter(maxSplitter, -500);
    const minLayout = await evaluate(client, `(()=>{const selector=document.querySelector('.cmp-selector'),splitter=document.querySelector('#cmpSplitter');return {selectorWidth:selector.getBoundingClientRect().width,ariaMin:Number(splitter.getAttribute('aria-valuemin'))}})()`);
    await assertNear('拖拽最小宽度边界', minLayout.selectorWidth, minLayout.ariaMin, 2);
    await evaluate(client, `document.querySelector('#cmpSplitter').focus();true`);
    await dispatchKey(client, 'Home', 'Home', 36);
    const homeWidth = await evaluate(client, `Number(document.querySelector('#cmpSplitter').getAttribute('aria-valuenow'))`);
    await assertNear('分隔条 Home 键调至最小宽度', homeWidth, minLayout.ariaMin, 0);
    await dispatchKey(client, 'End', 'End', 35);
    const endWidth = await evaluate(client, `Number(document.querySelector('#cmpSplitter').getAttribute('aria-valuenow'))`);
    await assertNear('分隔条 End 键调至最大宽度', endWidth, maxLayout.ariaMax, 0);
    await dispatchKey(client, 'ArrowLeft', 'ArrowLeft', 37);
    const arrowWidth = await evaluate(client, `Number(document.querySelector('#cmpSplitter').getAttribute('aria-valuenow'))`);
    if (arrowWidth >= endWidth) fail('ASSERTION_FAILED:分隔条方向键调宽');
    console.log('  PASS 分隔条方向键调宽');
    await client.command('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
    await wait(100);
    await assertBrowser(client, '移动端分隔条隐藏且模型树可收缩无页面横溢出', `(()=>{const splitter=document.querySelector('#cmpSplitter'),layout=document.querySelector('.cmp-layout'),selector=document.querySelector('.cmp-selector'),name=document.querySelector('.cmp-tree-node-name');const mw=name?getComputedStyle(name).minWidth:'0';return getComputedStyle(splitter).display==='none'&&getComputedStyle(selector).position==='static'&&!getComputedStyle(layout).gridTemplateColumns.includes('8px')&&(!name||mw==='0'||mw==='0px')&&document.documentElement.scrollWidth<=document.documentElement.clientWidth})()`);
    await captureScreenshot(client, MOBILE_SCREENSHOT);
    console.log(`  PASS 移动端视觉截图 ${MOBILE_SCREENSHOT}`);
    // headless 默认视口宽度仅 500px（< 560px 移动断点），仅 clear 不会回到桌面布局；
    // 必须显式恢复桌面视口后再验证「移动端 → 桌面端」切换恢复。
    await client.command('Emulation.setDeviceMetricsOverride', { width: 1366, height: 900, deviceScaleFactor: 1, mobile: false });
    await wait(100);
    await evaluate(client, `(()=>{const input=document.querySelector('#cmpModelSearch');input.value='';input.dispatchEvent(new Event('input',{bubbles:true}));return true})()`);
    await wait(300);
    await evaluate(client, `(()=>{const splitter=document.querySelector('#cmpSplitter');splitter.focus();splitter.dispatchEvent(new KeyboardEvent('keydown',{key:'Home',bubbles:true}));return true})()`);
    await wait(50);
    await assertBrowser(client, '恢复桌面端对比布局', `getComputedStyle(document.querySelector('#cmpSplitter')).display!=='none'&&getComputedStyle(document.querySelector('.cmp-selector')).position==='sticky'`);
    const treeStability = await evaluate(client, `(async()=>{const input=document.querySelector('#cmpModelSearch'),list=document.querySelector('#cmpModelList');input.value='';input.dispatchEvent(new Event('input',{bubbles:true}));await new Promise(resolve=>setTimeout(resolve,300));const frame=()=>new Promise(requestAnimationFrame);const frames=async()=>{await frame();await frame()};const listRect=()=>list.getBoundingClientRect();const offset=element=>element.getBoundingClientRect().top-listRect().top;const visible=(elements,min=48)=>elements.find(element=>{const rect=element.getBoundingClientRect(),root=listRect();return rect.top>=root.top+min&&rect.bottom<=root.bottom-min});list.scrollTop=Math.max(1,Math.floor((list.scrollHeight-list.clientHeight)*0.45));const vendor=visible([...list.querySelectorAll('[data-cmp-vendor]')])||[...list.querySelectorAll('[data-cmp-vendor]')][0];if(!vendor)return {error:'vendor-missing'};const vendorKey=vendor.getAttribute('data-cmp-vendor'),vendorBefore=offset(vendor),vendorScroll=list.scrollTop;vendor.querySelector('[data-cmp-vendor-toggle]').click();await frames();const vendorOpen=[...list.querySelectorAll('[data-cmp-vendor]')].find(item=>item.getAttribute('data-cmp-vendor')===vendorKey);const vendorOpenDelta=offset(vendorOpen)-vendorBefore;const vendorOpenScroll=list.scrollTop;const series=vendorOpen&&(visible([...vendorOpen.querySelectorAll('[data-cmp-series]')],28)||vendorOpen.querySelector('[data-cmp-series]'));if(!series)return {error:'series-missing',vendorOpenDelta,vendorOpenScroll,vendorBefore,vendorScroll};const seriesKey=series.getAttribute('data-cmp-series'),seriesBefore=offset(series),seriesScroll=list.scrollTop;series.querySelector('[data-cmp-series-toggle]').click();await frames();const seriesOpen=[...list.querySelectorAll('[data-cmp-series]')].find(item=>item.getAttribute('data-cmp-series')===seriesKey);const seriesOpenDelta=offset(seriesOpen)-seriesBefore;const seriesOpenScroll=list.scrollTop;seriesOpen.querySelector('[data-cmp-series-toggle]').click();await frames();const seriesClose=[...list.querySelectorAll('[data-cmp-series]')].find(item=>item.getAttribute('data-cmp-series')===seriesKey);const seriesCloseDelta=offset(seriesClose)-seriesBefore;const seriesCloseScroll=list.scrollTop;const vendorBeforeClose=[...list.querySelectorAll('[data-cmp-vendor]')].find(item=>item.getAttribute('data-cmp-vendor')===vendorKey);vendorBeforeClose.querySelector('[data-cmp-vendor-toggle]').click();await frames();const vendorClose=[...list.querySelectorAll('[data-cmp-vendor]')].find(item=>item.getAttribute('data-cmp-vendor')===vendorKey);const vendorCloseDelta=offset(vendorClose)-vendorBefore;const vendorCloseScroll=list.scrollTop;return {vendorOpenDelta,vendorCloseDelta,seriesOpenDelta,seriesCloseDelta,vendorScroll,vendorOpenScroll,vendorCloseScroll,seriesScroll,seriesOpenScroll,seriesCloseScroll,vendorExpanded:vendorClose?.querySelector('[data-cmp-vendor-toggle]')?.getAttribute('aria-expanded'),seriesExpanded:seriesClose?.querySelector('[data-cmp-series-toggle]')?.getAttribute('aria-expanded')}})()`);
    if (treeStability?.error) fail(`ASSERTION_FAILED:树滚动锚点${treeStability.error}`);
    await assertNear('厂商展开滚动锚定', treeStability.vendorOpenDelta, 0, 2);
    await assertNear('厂商收起滚动锚定', treeStability.vendorCloseDelta, 0, 2);
    await assertNear('系列展开滚动锚定', treeStability.seriesOpenDelta, 0, 2);
    await assertNear('系列收起滚动锚定', treeStability.seriesCloseDelta, 0, 2);
    if (treeStability.vendorExpanded !== 'false' || treeStability.seriesExpanded !== 'false') fail('ASSERTION_FAILED:树展开状态与收起结果不一致');
    console.log('  PASS 树展开状态与收起结果一致');
    await assertBrowser(client, '对比页加载', `(()=>{return document.querySelector('#view-compare').classList.contains('active')})()`);
    await evaluate(client, `(()=>{const input=document.querySelector('#cmpModelSearch');input.value='GLM-5.3';input.dispatchEvent(new Event('input',{bubbles:true}));return new Promise(resolve=>setTimeout(()=>resolve(true),500))})()`);
    await assertBrowser(client, '搜索自动展开厂商与系列', `(()=>{const model=[...document.querySelectorAll('[data-cmp-pick]')].find(item=>item.textContent.toLowerCase().replace(/-/g,' ').includes('glm 5.3'));const series=model?.closest('[data-cmp-series]');const vendor=series?.closest('[data-cmp-vendor]');return !!model&&series?.querySelector('[data-cmp-series-toggle]')?.getAttribute('aria-expanded')==='true'&&vendor?.querySelector('[data-cmp-vendor-toggle]')?.getAttribute('aria-expanded')==='true'})()`);
    await assertBrowser(client, '对比厂商与具体模型图标加载', `(()=>{const model=[...document.querySelectorAll('[data-cmp-pick]')].find(item=>item.textContent.toLowerCase().replace(/-/g,' ').includes('glm 5.3'));const vendor=model?.closest('[data-cmp-vendor]');return vendor?.getAttribute('data-cmp-vendor')==='zhipu'&&!!vendor.querySelector('[data-cmp-vendor-toggle] .brand-icon')&&!!model.querySelector('.brand-icon')})()`);
    await assertBrowser(client, '厂商与系列可独立折叠', `(()=>{const model=[...document.querySelectorAll('[data-cmp-pick]')].find(item=>item.textContent.toLowerCase().replace(/-/g,' ').includes('glm 5.3'));const series=model?.closest('[data-cmp-series]');const vendor=series?.closest('[data-cmp-vendor]');if(!series||!vendor)return false;const vendorKey=vendor.getAttribute('data-cmp-vendor');const seriesKey=series.getAttribute('data-cmp-series');const findVendor=()=>[...document.querySelectorAll('[data-cmp-vendor]')].find(item=>item.getAttribute('data-cmp-vendor')===vendorKey);const findSeries=()=>[...document.querySelectorAll('[data-cmp-series]')].find(item=>item.getAttribute('data-cmp-series')===seriesKey);vendor.querySelector('[data-cmp-vendor-toggle]').click();if(findVendor()?.classList.contains('expanded'))return false;findVendor()?.querySelector('[data-cmp-vendor-toggle]')?.click();const expandedSeries=findSeries();const seriesToggle=expandedSeries?.querySelector('[data-cmp-series-toggle]');if(!seriesToggle)return false;seriesToggle.click();if(findSeries()?.classList.contains('expanded'))return false;findSeries()?.querySelector('[data-cmp-series-toggle]')?.click();return !!findSeries()?.querySelector('[data-cmp-pick]')})()`);
    await evaluate(client, `(()=>{const model=[...document.querySelectorAll('[data-cmp-pick]')].find(item=>item.textContent.toLowerCase().replace(/-/g,' ').includes('glm 5.3'));model?.click();return new Promise(resolve=>setTimeout(()=>resolve(true),500))})()`);
    await assertBrowser(client, '选择模型后显示对比结果且树节点不挤连', `(()=>{const result=document.querySelectorAll('#cmpChips [data-cmp-remove]').length>0&&document.querySelector('#cmpResults')?.innerText.trim().length>0;const node=[...document.querySelectorAll('[data-cmp-pick]')].find(item=>item.getAttribute('aria-pressed')==='true')||document.querySelector('[data-cmp-pick]');const name=node?.querySelector('.cmp-tree-node-name'),score=node?.querySelector('.cmp-tree-score');if(!result||!name||!score)return false;const nameRect=name.getBoundingClientRect(),scoreRect=score.getBoundingClientRect(),style=getComputedStyle(name);return (style.minWidth==='0'||style.minWidth==='0px')&&style.overflow==='hidden'&&nameRect.right<=scoreRect.left})()`);
    await evaluate(client, `(async()=>{const payload=await fetch('data/comparison/integrated/index.json').then(response=>response.json());const hit=payload.series.flatMap(series=>series.members.map(member=>({series,member}))).find(item=>item.member.variants?.length>1);if(!hit)return false;const input=document.querySelector('#cmpModelSearch');input.value=hit.member.display;input.dispatchEvent(new Event('input',{bubbles:true}));await new Promise(resolve=>setTimeout(resolve,500));return true})()`);
    await assertBrowser(client, '多 revision 模型仍可切换', `(()=>{const select=document.querySelector('#cmpModelList select[data-cmp-revision]');if(!select||select.options.length<2)return false;select.selectedIndex=select.selectedIndex===0?1:0;select.dispatchEvent(new Event('change',{bubbles:true}));return document.querySelectorAll('#cmpChips [data-cmp-remove]').length>0})()`);
    await evaluate(client, `(async()=>{const payload=await fetch('data/comparison/integrated/data.json').then(response=>response.json());const hit=payload.models.find(model=>Object.values(model.degrees||{}).some(degrees=>Array.isArray(degrees)&&degrees.length>1));if(!hit)return true;const input=document.querySelector('#cmpModelSearch');input.value=hit.display;input.dispatchEvent(new Event('input',{bubbles:true}));await new Promise(resolve=>setTimeout(resolve,500));const button=[...document.querySelectorAll('[data-cmp-pick]')].find(item=>item.textContent.trim()===hit.display);if(button?.getAttribute('aria-pressed')!=='true')button?.click();await new Promise(resolve=>setTimeout(resolve,500));const trigger=document.querySelector('#cmpChips [data-cmp-variant]');if(!trigger)return false;trigger.click();return !!document.querySelector('#cmpVariantPopover')})()`);
    await assertBrowser(client, 'degree 变体切换后结果保留', `(()=>{const pop=document.querySelector('#cmpVariantPopover');if(!pop)return true;const slot=pop.querySelector('[data-cmp-variant-slot]');if(!slot)return false;slot.click();return document.querySelector('#cmpResults')?.innerText.trim().length>0})()`);
    await assertBrowser(client, '排除模型不在对比搜索', `(()=>{const input=document.querySelector('#cmpModelSearch');input.value='GPT-5.2';input.dispatchEvent(new Event('input',{bubbles:true}));return new Promise(resolve=>setTimeout(()=>resolve(!document.querySelector('#cmpModelList').innerText.includes('GPT-5.2')),400))})()`);
    // ── MVP 测试收尾：全视图冒烟 + 跨视图联动（阶段 5 验收项） ──
    // AI 搜索流程：点击示例按钮（触发 selectSearchExample + submitSearchHome 自动提交）
    // 搜索有动画阶段（每阶段 450ms），这里轮询等待结果面板显示而不是固定短等待。
    await evaluate(client, `(()=>{document.querySelector('[data-view="search"]').click();const example=document.querySelector('.chip.search-example');if(!example)return false;example.click();return true})()`);
    const searchResultsEnd = Date.now() + 8000;
    while (Date.now() < searchResultsEnd && !(await evaluate(client, `(()=>{const p=document.querySelector('#searchResultsPanel');return !!p&&!p.hidden})()`))) await wait(200);
    await assertBrowser(client, 'AI 搜索流程：提交后进入结果视图', `(()=>{const p=document.querySelector('#searchResultsPanel');return !!p&&!p.hidden&&p.innerText.trim().length>0})()`);
    // 空态体验：输入无匹配查询 → 显示「暂无对应静态示例」提示
    await evaluate(client, `(()=>{document.querySelector('[data-view="search"]').click();const input=document.querySelector('#aiSearchInput');input.value='不存在的查询词xyz';input.dispatchEvent(new Event('input',{bubbles:true}));document.querySelector('#aiSearchSubmit').click();return true})()`);
    await wait(300);
    await assertBrowser(client, '搜索空态：无匹配时显示提示', `document.querySelector('#searchUnsupportedState')&&!document.querySelector('#searchUnsupportedState').hidden`);
    await evaluate(client, `(()=>{document.querySelector('[data-view="compare"]').click();document.querySelector('#compareTabTool').click();return true})()`); await wait(200);
    await assertBrowser(client, '工具对比 tab 可切换且显示空态', `document.querySelector('#compareToolPanel')&&!document.querySelector('#compareToolPanel').hidden&&document.querySelector('#compareTable .compare-empty')&&document.querySelector('#compareTable .compare-add-trigger, #compareTable .btn-primary')`); const toolComparePicks = await evaluate(client, `(async()=>{const [cardPayload,detailPayload]=await Promise.all([fetch('data/catalog/tool-cards.json').then(r=>r.json()),fetch('data/catalog/tool-preview-level3.json').then(r=>r.json())]);const cards=Array.isArray(cardPayload?.items)?cardPayload.items:[],details=Array.isArray(detailPayload?.items)?detailPayload.items:[],byId=new Map(details.map(item=>[item.id,item]));return cards.map(card=>{const detail=byId.get(card.detail_ref?.id);return detail?.detail_kind==='tool'?{title:detail.title||card.title,toolId:card.tool_key,itemId:detail.id}:null}).filter(Boolean).slice(0,2)})()`);
    if (!Array.isArray(toolComparePicks) || toolComparePicks.length < 2) fail(`ASSERTION_FAILED:工具对比动态取样不足:${JSON.stringify(toolComparePicks)}`); await evaluate(client, `(async()=>{for(const pick of ${JSON.stringify(toolComparePicks)}){window.openAddComparePanel();await new Promise(resolve=>setTimeout(resolve,80));const input=document.querySelector('#addCompareSearch');input.value=pick.title;input.dispatchEvent(new Event('input',{bubbles:true}));await new Promise(resolve=>setTimeout(resolve,120));const item=[...document.querySelectorAll('#addCompareList .add-compare-item')].find(row=>row.querySelector('strong')?.textContent.trim()===pick.title);if(!item)return false;item.querySelector('button').click();await new Promise(resolve=>setTimeout(resolve,100));}return true})()`);
    await assertBrowser(client, '工具对比选择项与同类结果表真实渲染', `(()=>{const table=document.querySelector('#compareTable'),style=table&&getComputedStyle(table);return document.querySelectorAll('#compareSelection [data-compare-remove]').length===2&&!!table?.querySelector('.compare-table')&&style?.overflowX==='auto'&&table.scrollWidth>=table.clientWidth})()`);
    await assertBrowser(client, '工具对比移除一项立即回到不足两项空态', `(()=>{document.querySelector('#compareSelection [data-compare-remove]')?.click();return document.querySelectorAll('#compareSelection [data-compare-remove]').length===1&&!!document.querySelector('#compareTable .compare-empty')})()`);
    await assertBrowser(client, '工具对比移除至零项保留添加入口', `(()=>{document.querySelector('#compareSelection [data-compare-remove]')?.click();return document.querySelectorAll('#compareSelection [data-compare-remove]').length===0&&!!document.querySelector('#compareTable .compare-empty .btn-primary')})()`); // 跨视图联动：工具详情里的 +对比 → 关闭弹窗并路由到对比视图
    await evaluate(client, `(()=>{document.querySelector('[data-view="tools"]').click();const input=document.querySelector('#searchInput');input.value='Qwen3.8 Max';input.dispatchEvent(new Event('input',{bubbles:true}));return true})()`); await wait(300); await evaluate(client, `(()=>{const card=[...document.querySelectorAll('.tool-card')].find(x=>x.innerText.includes('Qwen3.8 Max'));card?.click();return !!card})()`);
    await wait(300);
    await evaluate(client, `(()=>{const btn=document.querySelector('#modalContent .compare-toggle');if(!btn)return false;btn.click();return true})()`);
    await wait(300);
    await assertBrowser(client, '+对比 路由：关闭弹窗并跳转对比视图', `document.querySelector('#modalOverlay')?.hidden===true&&document.querySelector('#view-compare')?.classList.contains('active')`);
    // 场景视图
    await evaluate(client, `(()=>{document.querySelector('[data-view="scenes"]').click();return true})()`);
    await wait(300);
    await assertBrowser(client, '场景视图渲染场景入口', `document.querySelector('#scenePicker .scene-pick-chip')!==null`);
    await evaluate(client, `(()=>{document.querySelector('#scenePicker .scene-pick-chip')?.click();return true})()`);
    await wait(300);
    await assertBrowser(client, '场景详情可展开', `document.querySelector('#sceneDetail .scene-detail-card')!==null`);
    // AI 热点视图
    await evaluate(client, `(()=>{document.querySelector('[data-view="trending"]').click();return true})()`);
    await wait(300);
    await assertBrowser(client, '热点视图渲染卡片或状态', `document.querySelector('#trendingGrid .trending-card')!==null||document.querySelector('#trendingStatus .status-note')!==null`);
    await assertBrowser(client, '热点卡片可打开详情', `(()=>{const card=document.querySelector('#trendingGrid .trending-card');if(!card)return false;card.click();return document.querySelector('#modalOverlay')?.hidden===false&&!!document.querySelector('[data-hotspot-detail]')})()`);
    await evaluate(client, `window.closeModal?.();true`);
    // AI 概念视图
    await evaluate(client, `(()=>{document.querySelector('[data-view="glossary"]').click();return true})()`);
    await wait(300);
    await assertBrowser(client, '概念索引渲染', `document.querySelector('#glossaryIndexList .glossary-index-item')!==null`);
    await evaluate(client, `(()=>{document.querySelector('#glossaryIndexList .glossary-index-item')?.click();return true})()`);
    await wait(300);
    await assertBrowser(client, '概念详情渲染', `document.querySelector('#glossaryDetail .glossary-article')!==null`);
    // 编辑精选视图
    await evaluate(client, `(()=>{document.querySelector('[data-view="featured"]').click();return true})()`);
    await wait(300);
    await assertBrowser(client, '编辑精选视图渲染', `document.querySelector('#featuredPicksGrid')&&document.querySelector('#featuredPicksGrid').innerText.trim().length>0`);
    // 关于视图
    await evaluate(client, `(()=>{document.querySelector('[data-view="about"]').click();return true})()`);
    await wait(200);
    await assertBrowser(client, '关于视图渲染', `document.querySelector('#view-about')?.classList.contains('active')&&document.querySelector('#view-about').innerText.includes('知览')`);
    if (consoleErrors.length) fail(`BROWSER_CONSOLE_ERRORS:${consoleErrors.join(',')}`);
    console.log('Browser acceptance passed.');
  } finally {
    client?.socket.close();
    browser.kill();
    server.kill();
    await wait(500);
    try { fs.rmSync(profile, { recursive: true, force: true }); } catch (error) { console.warn(`TEMP_PROFILE_CLEANUP_WARNING:${error.code}`); }
  }
}
main().catch(error => { console.error(`Browser acceptance failed: ${error.message}`); process.exitCode = 1; });
