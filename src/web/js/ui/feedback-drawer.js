/**
 * feedback-drawer.js — 测试阶段全站反馈抽屉
 * 管理右缘反馈标签与滑出面板的开合：打开时隐藏标签，×/遮罩/Esc 关闭并回还焦点。
 */

let drawerTrigger = null;

function drawerElements() {
  return {
    trigger: document.getElementById('feedbackTab'),
    overlay: document.getElementById('feedbackDrawerOverlay'),
    drawer: document.getElementById('feedbackDrawer'),
    close: document.getElementById('feedbackDrawerClose'),
  };
}

function drawerFocusableElements() {
  const drawer = document.getElementById('feedbackDrawer');
  if (!drawer) return [];
  return [...drawer.querySelectorAll('a[href], button:not([disabled]), [tabindex]:not([tabindex="-1"])')]
    .filter(element => !element.hidden && element.getClientRects().length > 0);
}

export function isFeedbackDrawerOpen() {
  const drawer = document.getElementById('feedbackDrawer');
  return Boolean(drawer && !drawer.hidden);
}

export function openFeedbackDrawer() {
  const { trigger, overlay, drawer, close } = drawerElements();
  if (!trigger || !overlay || !drawer || !drawer.hidden) return;
  drawerTrigger = trigger;
  trigger.hidden = true;
  trigger.setAttribute('aria-expanded', 'true');
  overlay.hidden = false;
  drawer.hidden = false;
  document.body.classList.add('feedback-drawer-open');
  close?.focus({ preventScroll: true });
}

export function closeFeedbackDrawer({ restoreFocus = true } = {}) {
  const { trigger, overlay, drawer } = drawerElements();
  if (!trigger || !overlay || !drawer || drawer.hidden) return;
  drawer.hidden = true;
  overlay.hidden = true;
  document.body.classList.remove('feedback-drawer-open');
  trigger.hidden = false;
  trigger.setAttribute('aria-expanded', 'false');
  const returnTarget = drawerTrigger;
  drawerTrigger = null;
  if (restoreFocus && returnTarget?.isConnected) returnTarget.focus({ preventScroll: true });
}

export function setupFeedbackDrawer() {
  const { trigger, overlay, close } = drawerElements();
  if (!trigger || !overlay) return;
  trigger.addEventListener('click', openFeedbackDrawer);
  close?.addEventListener('click', () => closeFeedbackDrawer());
  overlay.addEventListener('click', () => closeFeedbackDrawer({ restoreFocus: false }));
  document.addEventListener('keydown', event => {
    if (!isFeedbackDrawerOpen()) return;
    // 站点模态弹窗优先处理键盘，抽屉让位
    if (!document.getElementById('modalOverlay')?.hidden) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      closeFeedbackDrawer();
      return;
    }
    if (event.key !== 'Tab') return;
    const focusable = drawerFocusableElements();
    if (!focusable.length) { event.preventDefault(); close?.focus(); return; }
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
  });
}
