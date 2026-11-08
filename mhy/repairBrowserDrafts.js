// Add by MHY, 保留完整草稿副本后将 0.2.1 草稿转换为回退版本可读的文本。
(() => {
  const updates = [];
  for (const key of Object.keys(localStorage)) {
    if (!key.startsWith('dsh.conversation.')) continue;
    const raw = localStorage.getItem(key);
    let value;
    try { value = JSON.parse(raw); } catch { continue; }
    if (value && typeof value === 'object' && value.draft &&
        typeof value.draft === 'object' && typeof value.draft.text === 'string') {
      updates.push({ key, raw, value: { ...value, draft: value.draft.text } });
    }
  }
  if (updates.length === 0) {
    console.info('没有发现需要转换的新格式草稿。');
    return { count: 0 };
  }
  const backupKey = 'dsh.recovery.021-drafts.' + Date.now();
  localStorage.setItem(backupKey, JSON.stringify(updates.map(({ key, raw }) => ({ key, raw }))));
  for (const { key, value } of updates) localStorage.setItem(key, JSON.stringify(value));
  console.info('草稿文本已保留并转换，请刷新页面。', { count: updates.length, backupKey });
  return { count: updates.length, backupKey };
})();
