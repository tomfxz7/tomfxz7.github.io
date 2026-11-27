export async function applyGesture(direction, showView) {
  if (direction === 'up') {
    await chrome.tabs.create({});
  } else if (direction === 'down') {
    const tab = await chrome.tabs.getCurrent();
    if (tab?.id != null) await chrome.tabs.remove(tab.id);
  } else if (direction === 'left' || direction === 'right') {
    showView(direction === 'left' ? 'apps' : 'sites');
  }
}
