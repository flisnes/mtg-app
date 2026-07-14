// On Android Chrome the value of env(safe-area-inset-bottom) oscillates as the
// URL/chrome bar hides and shows during scroll. Because the tab bar's height is
// derived from --safe-bottom, that made the bar visibly grow and shrink while
// scrolling. We measure the inset once (and again only on orientation change)
// and pin --safe-bottom to that fixed pixel value so it no longer reacts to
// scroll-driven chrome changes.

function measureSafeBottom(): number {
  const probe = document.createElement('div');
  probe.style.cssText =
    'position:fixed;bottom:0;left:0;width:0;padding-bottom:env(safe-area-inset-bottom,0px);visibility:hidden;pointer-events:none;';
  document.body.appendChild(probe);
  const inset = probe.offsetHeight;
  probe.remove();
  return inset;
}

function applySafeBottom(): void {
  const inset = measureSafeBottom();
  document.documentElement.style.setProperty('--safe-bottom', `${inset}px`);
}

export function freezeSafeArea(): void {
  applySafeBottom();
  // The safe area genuinely changes on rotation, so re-measure there — but not
  // on plain resize/scroll, which is exactly the churn we want to ignore.
  window.addEventListener('orientationchange', () => {
    // Wait for the viewport to settle after the rotation.
    window.setTimeout(applySafeBottom, 300);
  });
}
