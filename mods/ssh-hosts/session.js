// One host session = one tab: the SSH terminal on top and the SFTP pane below.
// Shared by the picker, the SFTP pane's mode switch and the floating pill.
//
// The terminal does not run ssh directly but `sftp_bridge.py shell`, which
// waits until the SFTP pane has signed in (one password or fingerprint for
// both) and then runs ssh over that same connection.
import { appHome, home, layout, panes, run, setShared, shared, spaces, window } from 'herdr';

export const WINDOWS = () => window()?.platform === 'windows';
export const PYTHON = () => WINDOWS() ? 'python' : 'python3';
export const CONFIG = () => home().replace(/[\\/]+$/, '') + '/.ssh/config';
export const HELPER = () => appHome().replace(/[\\/]+$/, '') + '/mods/ssh-hosts/sftp_bridge.py';

// The terminal's command for a host.
// -I: isolated, so PYTHONPATH and friends cannot change what runs.
export const shellArgv = alias => [PYTHON(), '-I', HELPER(), 'shell', alias, CONFIG()];

// Tabs opened from the picker, by tab id: { alias, target }.
export const sessions = () => shared('ssh-hosts.sessions') ?? {};

export function rememberSession(tabId, info) {
  const alive = new Set(spaces().flatMap(s => s.tabs.map(t => t.id)));
  const next = {};
  for (const [id, value] of Object.entries(sessions())) if (alive.has(id)) next[id] = value;
  next[tabId] = info;
  setShared('ssh-hosts.sessions', next);
}

// What a host tab holds now, or null if `tabId` is not one.
export function tabState(tabId) {
  if (!tabId) return null;
  const info = sessions()[tabId];
  const mine = panes().filter(p => p.tab === tabId);
  const sftpPane = mine.find(p => p.mod === 'ssh-hosts') ?? null;
  if (!info && !sftpPane) return null;
  const sshPane = mine.find(p => p.terminal) ?? null;
  const mode = sshPane?.zoomed ? 'ssh' : sftpPane?.zoomed ? 'sftp'
    : sshPane && sftpPane ? 'split' : sshPane ? 'ssh' : 'sftp';
  return { tabId, alias: info?.alias ?? '', target: info?.target ?? '', sshPane, sftpPane, mode };
}

// SFTP pane status, published by each SFTP pane for its tab.
export const liveStatus = tabId => (shared('ssh-hosts.sftp.live') ?? {})[tabId] ?? null;

const sftpProps = state => ({ mode: 'sftp', alias: state.alias, target: state.target, tab: state.tabId });

// Waits (a few frames) for a pane the last command made.
async function waitPane(cx, find) {
  for (let i = 0; i < 40; i++) {
    await cx.sleep(20);
    const found = find();
    if (found) return found;
  }
  return null;
}

function addSftp(state, zoom, cx) {
  run('pane.split', { direction: 'down', pane: state.sshPane.pane, mod: 'ssh-hosts', props: sftpProps(state) });
  cx.spawn(async cx => {
    const created = await waitPane(cx, () => panes().find(p => p.tab === state.tabId && p.mod === 'ssh-hosts'));
    if (!created) return;
    if (zoom) run('pane.zoom', { pane: created.pane });
    else run('pane.focus', { pane: state.sshPane.pane });
  });
}

function addSsh(state, zoom, cx) {
  const before = new Set(panes().map(p => p.pane));
  run('pane.split', { direction: 'down', pane: state.sftpPane.pane, argv: shellArgv(state.alias) });
  cx.spawn(async cx => {
    const created = await waitPane(cx, () => panes().find(p => p.tab === state.tabId && p.terminal && !before.has(p.pane)));
    if (!created) return;
    run('pane.swap', { pane: created.pane, target: state.sftpPane.pane });  // SSH goes back on top
    if (zoom) run('pane.zoom', { pane: created.pane });
    else run('pane.focus', { pane: created.pane });
  });
}

// SSH (terminal at 100%, SFTP kept in the background), Split, or SFTP (100%).
// A pane that was closed comes back, without signing in again.
export function setMode(next, state, cx) {
  if (!state) return;
  const { sshPane, sftpPane } = state;
  const unzoom = () => {
    if (sshPane?.zoomed) run('pane.zoom', { pane: sshPane.pane });
    else if (sftpPane?.zoomed) run('pane.zoom', { pane: sftpPane.pane });
  };
  if (next === 'split') {
    if (sshPane && sftpPane) { unzoom(); run('pane.focus', { pane: sshPane.pane }); }
    else if (sshPane) addSftp(state, false, cx);
    else if (sftpPane && state.alias) addSsh(state, false, cx);
    return;
  }
  const [own, other] = next === 'ssh' ? [sshPane, sftpPane] : [sftpPane, sshPane];
  if (own && other) {
    if (!own.zoomed) run('pane.zoom', { pane: own.pane });
    else run('pane.focus', { pane: own.pane });
  } else if (own) {
    run('pane.focus', { pane: own.pane });
  } else if (next === 'sftp') {
    addSftp(state, true, cx);
  } else if (state.alias) {
    addSsh(state, true, cx);
  }
}

// --- the optional side panel ---------------------------------------------------
// A layout may hold the picker as a block `{ mod: 'ssh-hosts', props: { panel: true } }`,
// like Files and Changes (a child of the right panel's stack). Then the shortcut
// and the buttons show it instead of the popup. Without one, nothing changes.

function pathTo(node, trail = []) {
  if (!node || typeof node !== 'object') return null;
  const here = [...trail, node];
  if (node.content?.mod === 'ssh-hosts' && node.content?.props?.panel) return here;
  for (const child of node.children ?? []) {
    const found = pathTo(child, here);
    if (found) return found;
  }
  return null;
}

// Root → … → the panel block, or null when the shown layout has none.
export const panelPath = () => pathTo(layout());

export function panelShown(path = panelPath()) {
  return Boolean(path) && path.every((node, i) => !node.hidden
    && (path[i - 1]?.type !== 'stack' || path[i - 1].active === node.id));
}

export function showPanel(path = panelPath()) {
  if (!path) return false;
  // Select first, then show: the panel never flashes another child (as Files does).
  path.forEach((node, i) => {
    const parent = path[i - 1];
    if (parent?.type === 'stack' && parent.active !== node.id) run('layout.select', { stack: parent.id, child: node.id });
  });
  for (const node of path) if (node.hidden) run('layout.show', { id: node.id });
  // The panel's search box takes the keyboard (the panel watches this).
  setShared('ssh-hosts.focusPanel', Date.now());
  return true;
}

// Hides what holds the panel: the nearest sized node above it (the right panel).
export function hidePanel(path = panelPath()) {
  const holder = path && [...path].reverse().find((node, i) => i > 0 && node.size && node.id);
  if (holder) run('layout.hide', { id: holder.id });
}

// The picker's button: toggles the side panel if the layout has one (false if not).
export function togglePanel() {
  const path = panelPath();
  if (!path) return false;
  if (panelShown(path)) hidePanel(path);
  else showPanel(path);
  return true;
}
