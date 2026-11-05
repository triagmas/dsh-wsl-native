import assert from 'node:assert/strict';
import test from 'node:test';
import {
  NEW_WSL_CHAT_ALIASES,
  NEW_WSL_CHAT_SHORTCUT_ID,
  planNewChat,
  type NewChatEntry,
} from '../src/new-chat.js';

function entries(list: Array<[string, NewChatEntry]>): Map<string, NewChatEntry> {
  return new Map(list);
}

test('default New Chat goes to the WSL runtime of the active environment', () => {
  const plan = planNewChat({
    settings: { distro: 'Ubuntu' },
    entries: entries([
      ['wsl:Ubuntu', { settings: { distro: 'Ubuntu' }, ready: true }],
      ['wsl:Debian', { settings: { distro: 'Debian' }, ready: true }],
    ]),
    activeKey: 'wsl:Ubuntu',
  });
  assert.equal(plan.kind, 'wsl');
  if (plan.kind !== 'wsl') return;
  assert.equal(plan.distro, 'Ubuntu');
  assert.equal(plan.entry?.settings.distro, 'Ubuntu');
});

test('the selected Ubuntu survives when the active environment is gone', () => {
  const plan = planNewChat({
    settings: { distro: 'Ubuntu' },
    entries: entries([['wsl:Debian', { settings: { distro: 'Debian' } }]]),
    activeKey: 'wsl:missing',
  });
  assert.equal(plan.kind, 'wsl');
  if (plan.kind !== 'wsl') return;
  assert.equal(plan.distro, 'Ubuntu');
  assert.equal(plan.entry, undefined);
});

test('the stored distribution is used when nothing is open', () => {
  const plan = planNewChat({ settings: { distro: 'Ubuntu' }, entries: entries([]), activeKey: null });
  assert.equal(plan.kind, 'wsl');
  if (plan.kind !== 'wsl') return;
  assert.equal(plan.distro, 'Ubuntu');
});

test('a whitespace-only distribution counts as not configured', () => {
  for (const distro of ['', '   ', '\t']) {
    const plan = planNewChat({ settings: { distro }, entries: entries([]), activeKey: null });
    assert.equal(plan.kind, 'error');
  }
});

test('no configuration is an error that the caller must show', () => {
  const plan = planNewChat({ settings: null, entries: entries([]), activeKey: null });
  assert.equal(plan.kind, 'error');
  if (plan.kind !== 'error') return;
  assert.equal(plan.reason, 'wsl-not-configured');
  assert.ok(plan.message.length > 0);
});

test('the plan never targets Windows, whatever the input', () => {
  const inputs = [
    { settings: null, entries: entries([]), activeKey: null },
    {
      settings: { distro: 'Ubuntu' },
      entries: entries([['k', { settings: { distro: 'Ubuntu' } }]]),
      activeKey: 'k',
    },
    { settings: { distro: 'Ubuntu' }, entries: entries([]), activeKey: 'missing' },
    { settings: {}, entries: entries([['k', { settings: { distro: '' } }]]), activeKey: 'k' },
  ];
  for (const input of inputs) {
    const plan = planNewChat(input);
    assert.ok(['wsl', 'error'].includes(plan.kind), 'unexpected plan kind ' + plan.kind);
  }
});

test('planning does not mutate the persisted selection', () => {
  const list = entries([['k', { settings: { distro: 'Ubuntu' } }]]);
  const settings = { distro: 'Ubuntu' };
  planNewChat({ settings, entries: list, activeKey: 'k' });
  planNewChat({ settings, entries: list, activeKey: null });
  assert.deepEqual(settings, { distro: 'Ubuntu' });
  assert.equal(list.size, 1);
  assert.equal(list.get('k')?.settings.distro, 'Ubuntu');
});

test('the shortcut contract stays stable', () => {
  assert.equal(NEW_WSL_CHAT_SHORTCUT_ID, 'dsh-wsl-native.session.new');
  assert.ok(NEW_WSL_CHAT_ALIASES.includes('new wsl chat'));
  assert.ok(NEW_WSL_CHAT_ALIASES.includes('wsl chat'));
});
