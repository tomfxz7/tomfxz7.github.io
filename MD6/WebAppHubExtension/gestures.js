function installMouseGestures(onGesture, enabled = () => true) {
  let start;
  let suppressMenuUntil = 0;

  window.addEventListener('pointerdown', event => {
    suppressMenuUntil = 0;
    start = event.isTrusted && event.pointerType === 'mouse' && event.button === 2 && !event.shiftKey && enabled()
      ? { x: event.clientX, y: event.clientY, id: event.pointerId } : undefined;
  }, true);

  window.addEventListener('pointerup', event => {
    if (!event.isTrusted || event.button !== 2 || event.pointerId !== start?.id) return;
    const dx = event.clientX - start.x;
    const dy = event.clientY - start.y;
    start = undefined;
    const horizontal = Math.abs(dx);
    const vertical = Math.abs(dy);
    const distance = Math.max(horizontal, vertical);
    if (distance < 40 || distance < 1.25 * Math.min(horizontal, vertical)) return;

    suppressMenuUntil = performance.now() + 500;
    event.preventDefault();
    event.stopImmediatePropagation();
    onGesture(horizontal > vertical ? (dx < 0 ? 'left' : 'right') : (dy < 0 ? 'up' : 'down'));
  }, true);

  window.addEventListener('contextmenu', event => {
    if (!event.isTrusted || event.shiftKey || event.button !== 2) return;
    if (start || performance.now() < suppressMenuUntil) {
      event.preventDefault();
      event.stopImmediatePropagation();
    }
  }, true);
  const reset = () => { start = undefined; suppressMenuUntil = 0; };
  window.addEventListener('pointercancel', reset, true);
  window.addEventListener('blur', reset);
}
