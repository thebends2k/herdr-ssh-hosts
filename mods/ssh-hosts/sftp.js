import { div, svg } from 'gpui-kit';
import { h_flex, v_flex, Editor, EditorState, Input, InputState, Scrollbar, v_virtual_list, VirtualListScrollHandle } from 'gpui-base';
import { checking, closeOverlay, exec, home, layout, openOverlay, props, settings, shared, setShared, theme } from 'herdr';
import { CONFIG, HELPER, PYTHON, WINDOWS, setMode, tabState } from './session.js';

// The SFTP view: this computer on the left, the server on the right.
// sftp_bridge.py owns the SSH connection and lists local folders too; this view
// talks to it over loopback HTTP: /rpc runs an action, /events waits until the
// state changes (progress and listings arrive at once, without polling), and
// password or host-key questions from OpenSSH arrive as `state.prompt` and are
// asked in a centered dialog (main.js, `auth`), once for SSH and SFTP.

const ROW = 28;
const SIDES = ['local', 'remote'];
const basename = path => path.replace(/[\\/]+$/, '').split(/[\\/]/).pop();
const sizeText = size => size == null ? '' : size < 1024 ? `${size} B` : size < 1048576 ? `${(size / 1024).toFixed(1)} KB`
  : size < 1073741824 ? `${(size / 1048576).toFixed(1)} MB` : `${(size / 1073741824).toFixed(2)} GB`;
const pad = n => String(n).padStart(2, '0');
const dateText = mtime => {
  if (!mtime) return '';
  const d = new Date(mtime * 1000), now = new Date();
  const time = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  if (d.toDateString() === now.toDateString()) return `today ${time}`;
  return `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()} ${time}`;
};
const permText = mode => mode == null ? '' : [6, 3, 0].map(s => ((mode >> s) & 4 ? 'r' : '-') + ((mode >> s) & 2 ? 'w' : '-') + ((mode >> s) & 1 ? 'x' : '-')).join('');
const duration = seconds => seconds < 60 ? `${Math.ceil(seconds)} s` : `${Math.floor(seconds / 60)} min ${Math.ceil(seconds % 60)} s`;
const icon = (name, size = 16) => svg(`mods/ssh-hosts/${name}.svg`).size(size).flex_none();
const SPINNER = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
const SORTS = [['name', 'Name'], ['size', 'Size'], ['mtime', 'Modified']];

// How much of the pane's top a pane header drawn over it (reveal: hover) covers:
// the toolbar starts below it, so the header never hides its buttons. A header
// mod that draws nothing over SFTP panes can say so, and gets the room back:
//   setShared('ssh-hosts.clearHeaders', [...(shared('ssh-hosts.clearHeaders') ?? []), '<its name>'])
function headerInset() {
  const find = node => {
    if (!node || typeof node !== 'object' || node.hidden) return null;
    if (node.content?.tab === 'active') return node.content.pane?.header ?? null;
    for (const child of node.children ?? []) { const found = find(child); if (found) return found; }
    return null;
  };
  const header = find(layout());
  if (!header || header.reveal !== 'hover' || (header.position ?? 'top') !== 'top') return 0;
  if ((shared('ssh-hosts.clearHeaders') ?? []).includes(header.content?.mod)) return 0;
  return Number(header.height) || 30;
}
const EMPTY = { path: '.', ready: false, busy: false, transfer: null, revision: 0, listing: -1, local_path: null, local_listing: -1, queue: -1, totals: null };
const STATUS = { queued: 'Queued', running: 'Transferring', conflict: 'Already exists: waiting', done: 'Done', skipped: 'Skipped', failed: 'Failed', cancelled: 'Cancelled' };

// Natural order without case: "file2" before "file10".
function natural(a, b) {
  const x = a.toLowerCase().split(/(\d+)/), y = b.toLowerCase().split(/(\d+)/);
  for (let i = 0; i < Math.min(x.length, y.length); i++) {
    if (x[i] === y[i]) continue;
    if (i % 2) return Number(x[i]) - Number(y[i]) || x[i].length - y[i].length;
    return x[i] < y[i] ? -1 : 1;
  }
  return x.length - y.length;
}

// Remembered in shared state: localStorage belongs to one copy of the mod and
// does not outlive it, and every SFTP tab is a new copy.
const load = (key, fallback) => shared('ssh-hosts.sftp.' + key) ?? fallback;
const save = (key, value) => setShared('ssh-hosts.sftp.' + key, value);

// One file list: what it shows, how it is sorted and filtered, what is selected.
class Panel {
  constructor(side, view, cx) {
    this.side = side;
    this.entries = [];
    this.selected = null;   // the cursor: the row the keyboard is on
    this.marked = new Set();  // the selection (Ctrl / Shift add to it)
    this.anchor = null;     // where a Shift range starts
    this.focus = cx.focus_handle();
    this.scroll = VirtualListScrollHandle.new();
    this.query = '';
    const saved = load('view:' + side, {});
    this.sort = saved.sort ?? { key: 'name', dir: 1 };
    this.showHidden = saved.showHidden ?? false;
    this.search = InputState.new({ placeholder: 'Filter…' });
    this.search.on('change', (_e, cx) => { this.query = this.search.value().toLowerCase(); cx.notify(); });
    this.pathInput = InputState.new({ value: '' });
    this.pathInput.on('submit', (_e, cx) => { this.editing = false; view.list(side, this.pathInput.value(), cx); });
    this.pathInput.on('blur', (_e, cx) => { if (this.editing) { this.editing = false; cx.notify(); } });
  }

  save() { save('view:' + this.side, { sort: this.sort, showHidden: this.showHidden }); }

  // Filtered and sorted entries, recomputed only when something they depend on changed.
  get shown() {
    const c = this.cache;
    if (c && c.entries === this.entries && c.query === this.query && c.hidden === this.showHidden
      && c.key === this.sort.key && c.dir === this.sort.dir) return c.list;
    const { key, dir } = this.sort;
    const list = this.entries.filter(e => (this.showHidden || !(e.hidden || e.name.startsWith('.')))
      && (!this.query || e.name.toLowerCase().includes(this.query)));
    list.sort((a, b) => (b.dir - a.dir)
      || (key === 'size' ? ((a.size ?? -1) - (b.size ?? -1)) * dir
        : key === 'mtime' ? ((a.mtime ?? 0) - (b.mtime ?? 0)) * dir : 0)
      || natural(a.name, b.name) * (key === 'name' ? dir : 1));
    this.cache = { entries: this.entries, query: this.query, hidden: this.showHidden, key, dir, list };
    return list;
  }

  get entry() { return this.entries.find(e => e.name === this.selected) ?? null; }

  // The selected entries in the order shown; the cursor's alone when nothing is marked.
  get selection() {
    const list = this.marked.size ? this.shown.filter(e => this.marked.has(e.name)) : [];
    return list.length ? list : this.entry ? [this.entry] : [];
  }

  reset() { this.selected = this.anchor = null; this.marked.clear(); }

  // A new folder: nothing selected, except that going up puts the cursor on
  // the folder just left, as file managers do.
  moved(from, to) {
    this.reset();
    if (!from || !to) return;
    const sep = from.includes('\\') && !from.includes('/') ? '\\' : '/';
    const base = to.endsWith(sep) ? to : to + sep;
    if (from.startsWith(base)) this.selected = this.anchor = from.slice(base.length).split(sep)[0] || null;
  }

  // After a refresh: forget what is gone.
  prune() {
    const names = new Set(this.entries.map(e => e.name));
    for (const name of [...this.marked]) if (!names.has(name)) this.marked.delete(name);
    if (this.selected && !names.has(this.selected)) this.selected = null;
  }

  select(name, { toggle = false, range = false } = {}) {
    const shown = this.shown;
    if (range && this.anchor != null) {
      const a = shown.findIndex(e => e.name === this.anchor), b = shown.findIndex(e => e.name === name);
      if (a >= 0 && b >= 0) {
        if (!toggle) this.marked.clear();
        for (let i = Math.min(a, b); i <= Math.max(a, b); i++) this.marked.add(shown[i].name);
        this.selected = name;
        return;
      }
    }
    if (toggle) { if (this.marked.has(name)) this.marked.delete(name); else this.marked.add(name); }
    else { this.marked.clear(); this.marked.add(name); }
    this.selected = this.anchor = name;
  }

  selectAll() {
    this.marked = new Set(this.shown.map(e => e.name));
    if (!this.selected && this.shown.length) this.selected = this.anchor = this.shown[0].name;
  }

  // Moves the cursor by `delta` rows (or to an end), keeping it on screen.
  move(delta, extend = false) {
    const shown = this.shown;
    if (!shown.length) return;
    let i = shown.findIndex(e => e.name === this.selected);
    i = delta === -Infinity ? 0 : delta === Infinity ? shown.length - 1
      : i < 0 ? (delta > 0 ? 0 : shown.length - 1) : Math.max(0, Math.min(shown.length - 1, i + delta));
    this.select(shown[i].name, { range: extend });
    this.scroll.scroll_to_item(i);
  }

  release() { this.search.release(); this.pathInput.release(); this.focus.release(); }
}

export class SftpPanel {
  init(cx) {
    this.alias = props()?.alias || '';
    this.target = props()?.target || '';
    this.tab = props()?.tab || null;
    this.config = CONFIG();
    this.helper = HELPER();
    this.python = PYTHON();
    this.state = { ...EMPTY };
    this.generation = 0;
    this.panels = { local: new Panel('local', this, cx), remote: new Panel('remote', this, cx) };
    this.active = 'remote';
    this.name = InputState.new({ placeholder: 'Name' });
    this.name.on('submit', (_e, cx) => this.submit(cx));
    this.width = 1000;
    this.jobs = [];
    this.viewer = null;
    this.queueOpen = load('queueOpen', false);
    this.lastStatusKey = null;
    if (!checking()) this.connect(cx);
  }

  publishStatus() {
    if (!this.tab || this.closed) return;
    const s = this.state, n = s.totals;
    const connecting = this.starting || (this.conn && !s.ready && s.busy);
    const transferring = Boolean(n && (n.waiting || n.folders));
    const pct = transferring && n.bytes ? Math.min(100, Math.round((n.moved / n.bytes) * 100)) : null;
    const job = transferring && s.transfer ? this.jobs.find(j => j.id === s.transfer.id) : null;
    const dir = job?.kind === 'download' ? 'down' : 'up';
    const status = s.prompt ? 'prompt' : s.conflict ? 'conflict' : transferring ? 'transferring'
      : s.ready ? 'connected' : connecting ? 'connecting' : (this.error || s.error) ? 'error' : 'closed';
    const key = `${status}:${pct ?? ''}:${dir}`;
    if (key === this.lastStatusKey) return;
    this.lastStatusKey = key;
    const all = { ...(shared('ssh-hosts.sftp.live') ?? {}) };
    all[this.tab] = { alias: this.alias, status, pct, dir };
    setShared('ssh-hosts.sftp.live', all);
  }

  // --- talking to the bridge ---------------------------------------------

  headers(conn = this.conn) {
    return { Authorization: 'Bearer ' + conn.token, 'Content-Type': 'application/json' };
  }

  connect(cx) {
    if (this.starting) return;
    this.starting = true;
    this.answeredSecret = null;
    this.error = null;
    this.lost = false;
    this.state = { ...EMPTY };
    this.panels.remote.entries = [];
    const start = load('path:' + this.alias, '.');
    cx.spawn(async cx => {
      try {
        const result = await exec(this.python, ['-I', this.helper, 'start', this.alias, this.config, start]);
        let data;
        try { data = JSON.parse(result.stdout.trim()); }
        catch { throw new Error(result.stderr.trim() || 'Could not start the SFTP browser. Is Python 3 installed?'); }
        if (!data.ok) throw new Error(data.error || 'Could not start the SFTP browser');
        if (this.closed) { await this.post({ action: 'close' }, data).catch(() => {}); return; }
        this.conn = { url: data.url, token: data.token };
        this.listen(cx);
        // The last local folder used with this host, or the home folder if it is gone.
        const local = load('local:' + this.alias, home());
        this.rpc({ action: 'local_list', path: local }, cx, cx => this.rpc({ action: 'local_list', path: home() }, cx));
      } catch (error) { this.error = String(error.message || error); }
      finally { this.starting = false; this.publishStatus(); if (!this.closed) cx.notify(); }
    });
    this.publishStatus();
    cx.notify();
  }

  async post(args, conn = this.conn) {
    const response = await fetch(conn.url + '/rpc', { method: 'POST', body: JSON.stringify(args), headers: this.headers(conn) });
    const data = await response.json();
    if (!data.ok) throw new Error(data.error || 'SFTP error');
    return data;
  }

  // Long poll: each answer comes back as soon as the state changes.
  listen(cx) {
    const generation = ++this.generation;
    cx.spawn(async cx => {
      let failures = 0;
      while (generation === this.generation && !this.closed && this.conn) {
        try {
          const s = this.state;
          const url = `${this.conn.url}/events?since=${s.revision}&listing=${s.listing}&local=${s.local_listing}&queue=${s.queue}`;
          const data = await (await fetch(url, { headers: this.headers() })).json();
          if (generation !== this.generation || this.closed) return;
          if (!data.ok) throw new Error(data.error);
          failures = 0;
          this.apply(data);
        } catch (error) {
          if (generation !== this.generation || this.closed) return;
          if (++failures >= 3) {
            this.conn = null;
            this.state = { ...this.state, ready: false, busy: false, transfer: null, prompt: null };
            // As after a disconnect: the lists were the helper's, and the message goes where they were.
            for (const panel of Object.values(this.panels)) { panel.entries = []; panel.reset(); }
            this.askInDialog(null);
            this.lost = true;
            this.error = 'The SFTP browser stopped answering.';
            this.publishStatus();
          }
        }
        cx.notify();
      }
    });
  }

  rpc(args, cx, otherwise = null) {
    if (!this.conn) return;
    this.error = null;
    cx.spawn(async cx => {
      try { this.apply(await this.post(args)); }
      catch (error) { if (otherwise) otherwise(cx); else this.error = String(error.message || error); }
      if (!this.closed) cx.notify();
    });
  }

  apply(state) {
    if (this.closed) return;
    const old = this.state;
    if (state.revision < old.revision) return;  // an older answer arriving late
    const remote = this.panels.remote, local = this.panels.local;
    if (state.entries) {
      remote.entries = state.entries;
      if (state.path !== old.path) {
        remote.moved(old.path, state.path);
        if (state.path && state.path !== '.') save('path:' + this.alias, state.path);
      }
    } else state.listing = old.listing;  // not included: keep the entries shown
    if (state.jobs) this.jobs = state.jobs;
    else state.queue = old.queue;
    if (state.local_entries) {
      local.entries = state.local_entries;
      if (state.local_path !== old.local_path) {
        local.moved(old.local_path, state.local_path);
        save('local:' + this.alias, state.local_path);
      }
    } else state.local_listing = old.local_listing;
    if (state.entries) remote.prune();
    if (state.local_entries) local.prune();
    if (state.prompt?.id !== old.prompt?.id) this.askInDialog(state.prompt);
    if (state.ready && !old.ready) this.answeredSecret = null;
    if (state.conflict && state.conflict.id !== old.conflict?.id) this.applyAll = false;
    if (state.message && state.message !== old.message && !state.busy && this.form) {
      this.form = null;
      this.panels[this.active].focus.focus();  // back to the list the form was for
    }
    this.state = state;
    this.publishStatus();
  }

  // --- actions -------------------------------------------------------------

  // Browsing the server waits for its last browsing action; transfers run beside it.
  get enabled() { return Boolean(this.conn && this.state.ready && !this.state.busy); }
  get canTransfer() { return Boolean(this.conn && this.state.ready); }
  usable(side) { return side === 'local' ? Boolean(this.conn) : this.enabled; }

  list(side, path, cx) {
    if (!this.usable(side)) return;
    this.rpc({ action: side === 'local' ? 'local_list' : 'list', path }, cx);
  }

  // OpenSSH's question, in a centered dialog over the window: the SFTP pane may
  // be small or in the background (SSH mode) while the terminal waits on it.
  askInDialog(prompt) {
    if (this.dialog) { closeOverlay(this.dialog); this.dialog = null; }
    if (!prompt || !this.conn || this.closed) return;
    const secret = ['secret', 'passphrase', 'server'].includes(prompt.kind);
    // The same question again means the last answer was refused.
    const retry = secret && this.answeredSecret === prompt.text;
    if (secret) this.answeredSecret = prompt.text;
    this.dialog = openOverlay({ mod: 'ssh-hosts', kind: 'dialog', modal: true, width: 440,
      props: { auth: { url: this.conn.url, token: this.conn.token, prompt, retry, alias: this.alias, target: this.target } } });
  }

  disconnect(cx) {
    const conn = this.conn;
    this.askInDialog(null);
    this.generation++;
    this.conn = null;
    this.state = { ...EMPTY };
    for (const panel of Object.values(this.panels)) { panel.entries = []; panel.reset(); }
    this.jobs = [];
    this.viewer = null;
    this.form = null;
    this.error = null;
    this.lost = false;
    this.publishStatus();
    if (conn) cx.spawn(async () => { await this.post({ action: 'close' }, conn).catch(() => {}); });
    cx.notify();
  }

  // Queue the selection of one side (files and whole folders) for the other side.
  transfer(side, cx) {
    const chosen = this.panels[side].selection;
    if (!chosen.length || !this.canTransfer) return;
    this.rpc({ action: 'enqueue', kind: side === 'local' ? 'upload' : 'download',
      items: chosen.map(e => ({ name: e.name, dir: e.dir && !e.link, size: e.size })) }, cx);
  }

  showForm(kind, cx) {
    const side = this.active, panel = this.panels[side], entry = panel.entry;
    if (!this.usable(side)) return;
    if (kind === 'rename' && !entry) return;
    if (kind === 'delete' && !panel.selection.length) return;
    this.menu = null;
    this.form = kind;
    this.formSide = side;
    this.formEntry = entry;
    this.formEntries = panel.selection;
    this.name.set_value(kind === 'rename' ? entry.name : '');
    this.error = null;
    if (kind !== 'delete') this.name.focus();
    cx.notify();
  }

  submit(cx) {
    const kind = this.form, side = this.formSide, entry = this.formEntry;
    if (!kind || !this.usable(side)) return;
    const action = (side === 'local' ? 'local_' : '') + kind;
    if (kind === 'mkdir') this.rpc({ action, name: this.name.value() }, cx);
    else if (kind === 'rename') this.rpc({ action, name: entry.name, new_name: this.name.value() }, cx);
    else if (kind === 'delete') {
      const names = this.formEntries.map(e => e.name);
      this.rpc({ action, names, confirm: names }, cx);
    }
  }

  // Read-only viewer: the bridge reads the file (up to 1 MB) and nothing is saved.
  viewFile(cx) {
    const entry = this.panels.remote.entry;
    if (!entry || entry.dir || !this.enabled) return;
    this.menu = null;
    this.error = null;
    this.viewer = { name: entry.name, loading: true };
    cx.notify();
    cx.spawn(async cx => {
      try {
        const { view } = await this.post({ action: 'view', name: entry.name });
        if (this.closed || this.viewer?.name !== entry.name) return;
        const t = theme(), ext = view.name.includes('.') ? view.name.split('.').pop().toLowerCase() : 'txt';
        const language = { ts: 'js', tsx: 'js', mjs: 'js', cjs: 'js', jsx: 'js', toml: 'yaml', jsonc: 'json', yml: 'yaml', sh: 'bash', conf: 'txt', log: 'txt' }[ext] ?? ext;
        this.viewer = { name: view.name, size: view.size, code: EditorState.new({ language, readonly: true, value: view.text,
          font_family: settings().font_family, font_size: 12,
          syntax: { keyword: t.ansi5, string: t.ansi2, comment: t.dim, function: t.ansi4, type: t.ansi3, number: t.ansi1, constant: t.ansi6 } }) };
      } catch (error) {
        if (!this.closed && this.viewer) this.viewer = { name: entry.name, error: String(error.message || error) };
      }
      if (!this.closed) cx.notify();
    });
  }

  closeViewer(cx) {
    this.viewer = null;
    this.panels[this.active].focus.focus();
    cx.notify();
  }

  viewerCard(t) {
    const v = this.viewer;
    return v_flex().w(Math.max(360, this.width - 48)).h(Math.max(240, (this.height ?? 600) - 96)).max_w('100%').p(16).gap(10)
      .rounded(10).bg(t.popover).border_1().border_color(t.border)
      .child(h_flex().gap(8).items_center()
        .child(div().flex_1().truncate().font_semibold().text_size(13).child(v.name))
        .when(Boolean(v.size != null), el => el.child(div().text_color(t.dim).child(sizeText(v.size) + ' · read-only')))
        .child(this.button(t, 'viewer-close', 'Close', cx => this.closeViewer(cx), { primary: true })))
      .child(v.code ? Editor.new(v.code).flex_1().min_h(0)
        : div().flex_1().whitespace_normal().text_color(v.error ? t.ansi1 : t.dim).child(v.error || 'Reading file…'));
  }

  closeForm(cx) {
    this.form = null;
    this.panels[this.active].focus.focus();
    cx.notify();
  }

  // A click on a row. The list reports only which row; the press before it
  // (on_mouse_down on the list) says which modifiers were held and if it was double.
  click(side, name, cx) {
    const panel = this.panels[side], press = this.press ?? {};
    this.active = side;
    this.menu = null;
    panel.focus.focus();
    if (!this.usable(side)) return;
    const mods = press.modifiers ?? {};
    const toggle = Boolean(mods.control || mods.platform);
    panel.select(name, { toggle, range: Boolean(mods.shift) });
    if (press.click_count === 2 && !toggle && !mods.shift) this.open(side, cx);
    cx.notify();
  }

  // Enter / double click: into a folder, or the selection to the other side.
  open(side, cx) {
    const panel = this.panels[side], entry = panel.entry;
    if (!entry) return;
    if (entry.dir && panel.selection.length <= 1) this.list(side, entry.name, cx);
    else this.transfer(side, cx);
  }

  copyPaths(side, cx) {
    const s = this.state, panel = this.panels[side];
    const folder = side === 'local' ? s.local_path : s.path;
    const sep = side === 'local' && WINDOWS() ? '\\' : '/';
    const join = name => folder.endsWith(sep) ? folder + name : folder + sep + name;
    const list = panel.selection;
    cx.write_to_clipboard(list.length ? list.map(e => join(e.name)).join('\n') : folder);
    this.state = { ...s, message: list.length > 1 ? `${list.length} paths copied` : 'Path copied' };
    this.menu = null;
    cx.notify();
  }

  // The keyboard, while a file list has it.
  key(side, e, cx) {
    const panel = this.panels[side], m = e.modifiers, cmd = m.control || m.platform;
    const k = e.key, other = side === 'local' ? 'remote' : 'local';
    const handled = () => cx.stop_propagation();
    if (this.state.conflict) return;
    if (this.viewer) {
      if (k === 'escape' || k === 'enter' || k === 'f3') { this.closeViewer(cx); handled(); }
      return;
    }
    if (this.form) {
      if (k === 'enter') { this.submit(cx); handled(); }
      if (k === 'escape') { this.closeForm(cx); handled(); }
      return;
    }
    if (this.menu && k === 'escape') { this.menu = null; handled(); return cx.notify(); }
    if (k === 'tab') { this.active = other; this.panels[other].focus.focus(); handled(); return cx.notify(); }
    if (cmd && k === 'f') { panel.search.focus(); handled(); return; }
    if (cmd && k === 'r') { this.list(side, '.', cx); handled(); return; }
    if (cmd && k === 'h') { panel.showHidden = !panel.showHidden; panel.save(); handled(); return cx.notify(); }
    if (cmd && k === 'a') { panel.selectAll(); handled(); return cx.notify(); }
    if (cmd && k === 'c') { this.copyPaths(side, cx); handled(); return; }
    if (cmd || m.alt) return;
    const moves = { up: -1, down: 1, pageup: -10, pagedown: 10, home: -Infinity, end: Infinity };
    if (k in moves) { panel.move(moves[k], m.shift); handled(); return cx.notify(); }
    if (k === 'enter') { this.open(side, cx); handled(); return; }
    if (k === 'backspace') { this.list(side, '..', cx); handled(); return; }
    if (k === 'f3' && side === 'remote') { this.viewFile(cx); handled(); return; }
    if (k === 'f5') { this.transfer(side, cx); handled(); return; }
    if (k === 'f2') { this.showForm('rename', cx); handled(); return; }
    if (k === 'f7') { this.showForm('mkdir', cx); handled(); return; }
    if (k === 'delete') { this.showForm('delete', cx); handled(); return; }
    if (k === 'escape') {
      if (panel.query) { panel.search.set_value(''); panel.query = ''; }
      else panel.reset();
      handled();
      return cx.notify();
    }
  }

  // The right-click menu: for the rows under it, or for the folder.
  menuItems(side) {
    const panel = this.panels[side], chosen = this.menu?.row ? panel.selection : [];
    const one = chosen.length === 1 ? chosen[0] : null, n = chosen.length;
    const usable = this.usable(side), local = side === 'local';
    const items = [];
    if (one?.dir) items.push(['Open', 'Enter', cx => this.list(side, one.name, cx), usable]);
    if (one && !one.dir && !local) items.push(['View', 'F3', cx => this.viewFile(cx), usable]);
    if (n) items.push([local ? `Upload${n > 1 ? ` ${n} items` : ''} →` : `← Download${n > 1 ? ` ${n} items` : ''}`, 'F5',
      cx => this.transfer(side, cx), this.canTransfer]);
    if (n) items.push(['-']);
    if (one) items.push(['Rename', 'F2', cx => this.showForm('rename', cx), usable]);
    if (n) items.push([n > 1 ? `Delete ${n} items` : 'Delete', 'Del', cx => this.showForm('delete', cx), usable, true]);
    items.push(['New folder', 'F7', cx => this.showForm('mkdir', cx), usable]);
    items.push(['-']);
    items.push([n > 1 ? 'Copy paths' : 'Copy path', 'Ctrl+C', cx => this.copyPaths(side, cx), Boolean(this.conn)]);
    items.push(['Refresh', 'Ctrl+R', cx => this.list(side, '.', cx), usable]);
    items.push([panel.showHidden ? 'Hide hidden files' : 'Show hidden files', 'Ctrl+H',
      cx => { panel.showHidden = !panel.showHidden; panel.save(); cx.notify(); }, true]);
    items.push(['-']);
    // Sorting lives here: the panel has no column header row.
    for (const [key, label] of SORTS) {
      const on = panel.sort.key === key;
      items.push([`${on ? '✓ ' : ''}Sort by ${label.toLowerCase()}`, on ? (panel.sort.dir > 0 ? '▲' : '▼') : '',
        cx => this.sortBy(side, key, cx), true]);
    }
    return items;
  }

  menuView(t) {
    const { side, at } = this.menu;
    const items = this.menuItems(side);
    const height = items.reduce((h, i) => h + (i[0] === '-' ? 9 : 28), 10), width = 250;
    const x = Math.max(4, Math.min(at.x, this.width - width - 4)), y = Math.max(4, Math.min(at.y, (this.height ?? 600) - height - 4));
    return v_flex().id('sftp-menu').absolute().left(x).top(y).w(width).p(5).rounded(8).bg(t.popover)
      .border_1().border_color(t.border).shadow_lg()
      .on_mouse_down('left', (_e, cx) => cx.stop_propagation())
      .on_mouse_down_out((_e, cx) => { this.menu = null; cx.notify(); })
      .children(items.map((item, i) => {
        if (item[0] === '-') return div().h(1).my(4).mx(4).bg(t.border);
        const [label, keys, fn, active, danger] = item;
        return h_flex().id('menu-' + i).h(28).px(9).gap(10).items_center().rounded(5)
          .text_color(!active ? t.dim : danger ? t.ansi1 : t.foreground)
          .when(active, el => el.hover(s => s.bg(t.selected)).on_click((_e, cx) => { this.menu = null; fn(cx); cx.notify(); }))
          .child(div().flex_1().truncate().child(label))
          .child(div().text_size(11).text_color(t.dim).child(keys));
      }));
  }

  sortBy(side, key, cx) {
    const panel = this.panels[side];
    panel.sort = panel.sort.key === key ? { key, dir: -panel.sort.dir } : { key, dir: key === 'name' ? 1 : -1 };
    panel.save();
    cx.notify();
  }

  // --- drawing ---------------------------------------------------------------

  button(t, id, title, fn, { active = true, danger = false, primary = false, glyph = null, tip = null, on = false, h = 24 } = {}) {
    return h_flex().id('sftp-' + id).h(h).px(glyph && !title ? 0 : 8).when(glyph && !title, el => el.w(h).justify_center())
      .gap(5).items_center().rounded(5).flex_none()
      .when(!primary, el => el.border_1().border_color(on ? t.accent : t.border))
      .bg(primary && active ? danger ? t.ansi1 : t.solid : on ? t.selected : '#00000000')
      .role('button').accessibility_label(tip || title).when(Boolean(tip), el => el.tooltip(tip)).disabled(!active)
      .text_color(!active ? t.dim : primary ? t.solid_foreground : danger ? t.ansi1 : t.foreground)
      .when(active, el => el.hover(s => s.bg(primary ? t.solid : t.hover)).on_click((_e, cx) => fn(cx)))
      .when(Boolean(glyph), el => el.child(glyph)).when(Boolean(title), el => el.child(title));
  }

  input(t, state, label, enabled = true, h = 24) {
    return Input.new(state).h(h).px(7).min_w(0).flex_1().rounded(5).border_1().border_color(t.input)
      .bg(t.background).text_color(t.foreground).text_size(12).accessibility_label(label).disabled(!enabled);
  }

  card(t, title, ...children) {
    return v_flex().w(440).max_w('100%').p(16).gap(10).rounded(10).bg(t.popover).border_1().border_color(t.border)
      .child(div().font_semibold().text_size(13).child(title)).children(children);
  }

  formCard(t) {
    const kind = this.form, entry = this.formEntry;
    const where = this.formSide === 'local' ? 'on this computer' : `on ${this.alias}`;
    const actions = h_flex().gap(8).justify_end()
      .child(this.button(t, 'form-cancel', 'Cancel', cx => this.closeForm(cx)))
      .child(this.button(t, 'form-ok', { mkdir: 'Create', rename: 'Rename', delete: 'Delete' }[kind],
        cx => this.submit(cx), { primary: true, danger: kind === 'delete', active: this.usable(this.formSide) }));
    if (kind === 'delete') {
      const list = this.formEntries, one = list.length === 1 ? list[0] : null;
      const folders = list.some(e => e.dir && !e.link);
      return this.card(t, `Delete ${where}`,
        div().whitespace_normal().child(one ? `Delete ${one.dir && !one.link ? 'the folder ' : ''}“${one.name}”?`
          : `Delete these ${list.length} items?`),
        ...(one ? [] : [v_flex().max_h(140).overflow_y_scrollbar().id('delete-list').px(10).py(6).rounded(6).bg(t.surface)
          .children(list.slice(0, 50).map(e => div().truncate().text_color(t.muted).child((e.dir && !e.link ? '📁 ' : '') + e.name)))
          .when(list.length > 50, el => el.child(div().text_color(t.dim).child(`and ${list.length - 50} more…`)))]),
        div().text_size(11).text_color(t.muted).child(folders ? 'This cannot be undone. Only empty folders are deleted.' : 'This cannot be undone.'),
        actions);
    }
    return this.card(t, kind === 'mkdir' ? `New folder ${where}` : `Rename ${where}`,
      this.input(t, this.name, 'Name').flex_none().w_full(), actions);
  }

  // The queue stopped: this file's destination exists.
  conflictCard(t, c) {
    const side = (label, info) => v_flex().flex_1().min_w(0).p(10).gap(2).rounded(6).bg(t.surface).border_1().border_color(t.border)
      .child(div().text_size(11).text_color(t.dim).child(label))
      .child(div().child(info?.size == null ? '—' : sizeText(info.size)))
      .child(div().text_color(t.muted).child(dateText(info?.mtime) || '—'));
    const newer = (c.source?.mtime ?? 0) > (c.target?.mtime ?? 0);
    const choose = choice => cx => this.rpc({ action: 'resolve', id: c.id, choice, all: Boolean(c.more && this.applyAll) }, cx);
    return this.card(t, 'The file already exists',
      div().whitespace_normal().child(`“${c.name}” already exists in ${c.where}.`),
      h_flex().gap(8).child(side(c.kind === 'upload' ? 'This computer (new)' : `${this.alias} (new)`, c.source))
        .child(side(c.kind === 'upload' ? `${this.alias} (existing)` : 'This computer (existing)', c.target)),
      ...(newer ? [div().text_size(11).text_color(t.muted).child('The one being transferred is newer.')] : []),
      ...(c.more ? [h_flex().id('apply-all').gap(8).items_center().on_click((_e, cx) => { this.applyAll = !this.applyAll; cx.notify(); })
        .child(h_flex().w(16).h(16).flex_none().rounded(4).border_1().border_color(this.applyAll ? t.accent : t.input)
          .bg(this.applyAll ? t.accent : '#00000000').text_color(t.accent_foreground).text_size(11).items_center().justify_center()
          .child(this.applyAll ? '✓' : ''))
        .child('Do the same for the other files that already exist')] : []),
      h_flex().gap(8).justify_end()
        .child(this.button(t, 'cf-cancel', 'Cancel', cx => this.rpc({ action: 'cancel_job', id: c.id }, cx)))
        .child(div().flex_1())
        .child(this.button(t, 'cf-skip', 'Skip', choose('skip')))
        .child(this.button(t, 'cf-rename', 'Rename', choose('rename'), { tip: 'Save as “name (2)”' }))
        .child(this.button(t, 'cf-yes', 'Overwrite', choose('overwrite'), { primary: true, danger: true })));
  }

  // The path as clickable folders; a click on the empty part edits it as text.
  crumbs(side, path) {
    if (path == null) return [];
    if (side === 'local' && WINDOWS()) {
      const out = [{ label: 'Computer', path: '' }];
      let at = '';
      for (const part of path.split('\\').filter(Boolean)) {
        at = at ? (at.endsWith('\\') ? at : at + '\\') + part : part + '\\';
        out.push({ label: part, path: at });
      }
      return out;
    }
    const out = [{ label: '/', path: '/' }];
    let at = '';
    for (const part of path.split('/').filter(Boolean)) {
      at += '/' + part;
      out.push({ label: part, path: at });
    }
    return out;
  }

  pathBar(t, side, path) {
    const panel = this.panels[side];
    if (panel.editing) return div().flex_1().min_w(0).child(this.input(t, panel.pathInput, 'Path').w_full());
    const all = this.crumbs(side, path);
    const parts = all.length > 5 ? [all[0], { label: '…' }, ...all.slice(-3)] : all;
    return h_flex().id(`path-${side}`).flex_1().min_w(0).h(24).px(6).gap(2).items_center().rounded(5)
      .border_1().border_color(t.border).overflow_hidden().tooltip(path ? 'Click to type a path' : '')
      .on_click((_e, cx) => {
        if (!this.usable(side)) return;
        panel.editing = true;
        panel.pathInput.set_value(path ?? '');
        panel.pathInput.focus();
        cx.notify();
      })
      // Earlier folders shrink first; the current one stays readable.
      .children(parts.map((part, i) => h_flex().items_center().gap(2).min_w(0)
        .when(i === parts.length - 1, el => el.flex_shrink_0()).when(i < parts.length - 1, el => el.flex_shrink(1))
        .when(i > 0 && parts[i - 1].label !== '/', el => el.child(div().text_color(t.dim).child('›')))
        .child(part.path == null ? div().text_color(t.dim).child(part.label)
          : div().id(`crumb-${side}-${i}`).px(4).rounded(4).min_w(0).max_w(i === parts.length - 1 ? 260 : 160).truncate()
            .text_color(i === parts.length - 1 ? t.foreground : t.muted).hover(s => s.bg(t.hover).text_color(t.foreground))
            .on_click((_e, cx) => { cx.stop_propagation(); this.list(side, part.path, cx); }).child(part.label))))
      .child(div().flex_1().h_full());
  }

  // What a list shows when it has no rows to show, and what to do about it.
  emptyState(t, side, entries, connecting) {
    const s = this.state, panel = this.panels[side], remote = side === 'remote';
    const block = (title, detail, action, spin = false) => v_flex().absolute().top(0).left(0).right(0).pt(48).px(24).gap(8)
      .items_center()
      .child(h_flex().gap(8).items_center().text_color(spin ? t.muted : t.foreground)
        .when(spin, el => el.child(div().text_color(t.accent).child('⠋').frames(['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'], 90)))
        .child(title))
      .when(Boolean(detail), el => el.child(div().max_w(360).text_center().whitespace_normal().text_size(11).text_color(t.muted).child(detail)))
      .when(Boolean(action), el => el.child(div().pt(4).child(action)));
    const firstLine = text => text ? String(text).split('\n')[0] : '';
    if (!this.conn) {
      if (this.starting) return block('Starting…', '', null, true);
      if (remote) return null;  // the local panel explains it
      // Disconnected on purpose (or the error was hidden): not a failure.
      if (!this.error) return block(`Disconnected from ${this.alias}`, 'Your folders are remembered.',
        this.button(t, `connect-${side}`, 'Connect', cx => this.connect(cx), { primary: true }));
      if (this.lost) return block('Connection lost', firstLine(this.error),
        this.button(t, `reconnect-lost-${side}`, 'Reconnect', cx => this.connect(cx), { primary: true }));
      return block('Could not start the browser', firstLine(this.error),
        this.button(t, `retry-start-${side}`, 'Retry', cx => this.connect(cx), { primary: true }));
    }
    if (remote && !s.ready) {
      if (connecting) return block(s.prompt ? 'Waiting for the sign-in dialog…' : `Connecting to ${this.alias}…`,
        s.prompt ? 'One sign-in serves both the SSH terminal and this browser.'
          : 'If the server asks for a password or to confirm its fingerprint, a dialog will appear.', null, true);
      const shown = this.error || (s.error && s.error !== this.dismissedError);  // the banner above says why
      return block(`Not connected to ${this.alias}`, shown ? '' : firstLine(s.error),
        this.button(t, 'reconnect-panel', 'Reconnect', cx => this.reconnect(cx), { primary: true }));
    }
    if (entries.length) return null;
    if (panel.query) return block(`Nothing matches “${panel.query}”`, '',
      this.button(t, `clear-filter-${side}`, 'Clear filter', cx => { panel.search.set_value(''); panel.query = ''; cx.notify(); }));
    if (panel.entries.length) return block(`Only hidden files (${panel.entries.length})`, '',
      this.button(t, `show-hidden-${side}`, 'Show hidden', cx => { panel.showHidden = true; panel.save(); cx.notify(); }));
    return block('Empty folder', remote ? 'Drag files or folders here to upload them.' : '', null);
  }

  reconnect(cx) {
    if (this.conn) this.disconnect(cx);
    this.connect(cx);
  }

  row(t, entry, cols, mono, marked, cursor) {
    return h_flex().h(ROW).px(8).gap(8).items_center().rounded(5).bg(marked ? t.selected : '#00000000')
      .border_1().border_color(cursor ? t.accent : '#00000000')
      .text_color(entry.hidden || entry.name.startsWith('.') ? t.muted : t.foreground)
      .child(div().text_color(entry.dir ? t.accent : t.muted).child(icon(entry.dir ? 'folder' : 'file')))
      .child(div().flex_1().min_w(0).truncate().child(entry.name + (entry.link ? ' ↗' : '')))
      .child(div().w(72).text_right().text_color(t.muted).child(entry.dir ? '' : sizeText(entry.size)))
      .when(cols.date, el => el.child(div().w(112).text_right().text_color(t.dim).child(dateText(entry.mtime))))
      .when(cols.perms, el => el.child(div().w(80).text_right().text_color(t.dim).font_family(mono).text_size(11).child(permText(entry.mode))));
  }

  panel(t, side, width) {
    const s = this.state, panel = this.panels[side], remote = side === 'remote';
    const path = remote ? (s.ready ? s.path : null) : s.local_path;
    const usable = this.usable(side);
    const entries = panel.shown;
    const mono = settings().font_family ?? 'JetBrains Mono';
    const cols = { date: width > 360, perms: remote && width > 560 };
    const connecting = this.starting || (this.conn && !s.ready && s.busy);
    const empty = this.emptyState(t, side, entries, connecting);
    const focused = panel.focus.is_focused();
    const active = this.active === side;
    const label = remote ? this.alias : 'Local';
    const sideTip = remote ? `${this.alias}${this.target ? ' · ' + this.target : ''}` : 'This computer';
    const count = !this.conn || (remote && !s.ready) ? '' : entries.length === panel.entries.length
      ? `${panel.entries.length}` : `${entries.length} of ${panel.entries.length}`;

    return v_flex().id(`panel-${side}`).flex_1().min_w(0).min_h(0).rounded(8).border_1()
      .border_color(active ? t.accent : t.border).bg(t.background)
      .on_mouse_down('left', (_e, cx) => { if (this.active !== side) { this.active = side; panel.focus.focus(); cx.notify(); } })
      .when(remote, el => el.on_drop((event, cx) => {
        if (!this.canTransfer || !event.paths?.length) return;
        this.rpc({ action: 'enqueue', kind: 'upload', paths: event.paths }, cx);
      }))
      // The panel's one header row: which side, where, filter, hidden files.
      .child(h_flex().h(34).flex_none().px(6).gap(5).items_center().border_b_1().border_color(t.border)
        .child(h_flex().gap(5).px(2).items_center().flex_none().tooltip(`${sideTip}${count ? ' · ' + count + ' items' : ''}`)
          .child(div().text_color(active ? t.accent : t.muted).child(icon(remote ? 'server' : 'folder', 14)))
          .when(width > 420, el => el.child(div().max_w(110).truncate().font_semibold().text_size(11.5)
            .text_color(active ? t.foreground : t.muted).child(label))))
        .child(this.pathBar(t, side, path))
        .child(div().w(width > 480 ? 120 : 84).flex_none().child(this.input(t, panel.search, 'Filter by name', usable)))
        .child(this.button(t, `hidden-${side}`, '', cx => { panel.showHidden = !panel.showHidden; panel.save(); cx.notify(); },
          { on: panel.showHidden, glyph: div().text_size(11).child('.*'),
            tip: panel.showHidden ? 'Hide hidden files (Ctrl+H)' : 'Show hidden files (Ctrl+H)' })))
      .child(div().flex_1().min_h(0).relative().mx(4).my(4)
        .id(`keys-${side}`).track_focus(panel.focus)
        .on_key_down((e, cx) => this.key(side, e, cx))
        // The press comes before the row's click: keep its modifiers and click count for it.
        .on_mouse_down('left', (e, cx) => { this.press = e; panel.focus.focus(); })
        .on_mouse_down('right', () => { this.pendingMenu ??= { side, row: null }; })
        .child(v_virtual_list(`list-${side}`, entries.length, ROW, i => entries[i].name,
          range => entries.slice(range.start, range.end).map(e => this.row(t, e, cols, mono,
            panel.marked.has(e.name), focused && e.name === panel.selected)))
          .track_scroll(panel.scroll)
          .on_item_click((name, cx) => this.click(side, name, cx))
          .on_item_secondary_click((name, _e, cx) => {
            this.active = side;
            panel.focus.focus();
            if (!panel.marked.has(name)) panel.select(name);
            else panel.selected = name;
            this.pendingMenu = { side, row: name };
          })
          .size_full())
        .child(Scrollbar.vertical(`list-${side}`).viewport_from_layout().absolute().inset_0())
        .when(Boolean(empty), el => el.child(empty)));
  }

  // The transfer queue: a strip that only exists while there are transfers.
  // Folded it shows the running one; unfolded, every job. It goes away 3 s
  // after everything finished well; problems stay until cleared.
  queue(t, cx) {
    const s = this.state, x = s.transfer, n = s.totals;
    const jobs = this.jobs ?? [];
    if (!n || (!n.files && !n.folders && !jobs.length)) return null;
    const pct = n.bytes ? Math.min(100, (n.moved / n.bytes) * 100) : 0;
    const problems = n.failed + n.cancelled, finished = n.done + n.skipped + problems;
    const working = Boolean(n.waiting || n.folders);
    const running = x ? jobs.find(j => j.id === x.id) : null;
    const waiting = Math.max(0, n.files - finished - (running ? 1 : 0));
    if (!working && !problems && finished) {
      const key = `${s.queue}:${finished}`;
      if (this.autoClear !== key) {
        this.autoClear = key;
        cx.spawn(async cx => {
          await cx.sleep(3000);
          if (this.autoClear === key && !this.closed && this.conn) this.rpc({ action: 'clear' }, cx);
        });
      }
    }
    const headline = running
      ? `${running.kind === 'upload' ? '↑' : '↓'} ${running.name}${x.total ? ` · ${Math.floor((x.done / x.total) * 100)}%` : ''}`
      : working ? `Preparing ${n.folders ? 'folders' : 'files'}…`
        : `Done: ${n.done} transferred${n.skipped ? `, ${n.skipped} skipped` : ''}${problems ? `, ${problems} with problems` : ''}`;
    const rows = jobs.slice(0, 120);
    const color = { done: t.done, failed: t.ansi1, cancelled: t.dim, skipped: t.dim, conflict: t.blocked, running: t.accent, queued: t.muted };
    const row = job => {
      const now = x && x.id === job.id;
      const label = now && x.total ? `${Math.floor((x.done / x.total) * 100)} %` : job.renamed ? `Done as “${job.renamed}”` : STATUS[job.status];
      return h_flex().id('job-' + job.id).h(24).px(8).gap(8).items_center().rounded(5).flex_none()
        .when(Boolean(job.error), el => el.tooltip(job.error))
        .child(div().w(14).text_color(t.dim).child(job.kind === 'upload' ? '↑' : '↓'))
        .child(div().text_color(job.dir ? t.accent : t.muted).child(icon(job.dir ? 'folder' : 'file', 14)))
        .child(div().flex_1().min_w(0).truncate().child(job.name))
        .child(div().w(72).text_right().text_color(t.muted).child(sizeText(job.size)))
        .child(div().w(150).text_right().truncate().text_color(color[job.status]).child(job.error && job.status !== 'skipped' ? `${label}: ${job.error}` : label))
        .child(div().w(24).flex_none().when(job.status === 'queued' || now, el => el.child(
          this.button(t, 'jc-' + job.id, '', cx => this.rpc({ action: 'cancel_job', id: job.id }, cx), { glyph: icon('close', 13), tip: 'Cancel' })))
          .when(job.status === 'failed' || job.status === 'cancelled', el => el.child(
            this.button(t, 'jr-' + job.id, '', cx => this.rpc({ action: 'retry', id: job.id }, cx), { glyph: icon('refresh', 13), tip: 'Retry' }))));
    };
    const fold = cx => { this.queueOpen = !this.queueOpen; save('queueOpen', this.queueOpen); cx.notify(); };
    return v_flex().flex_none().border_t_1().border_color(t.border)
      .child(h_flex().id('queue-head').px(8).h(30).gap(8).items_center().hover(s => s.bg(t.hover))
        .tooltip(`${n.done + n.skipped} of ${n.files} files · ${sizeText(n.moved)} of ${sizeText(n.bytes)}`)
        .on_click((_e, cx) => fold(cx))
        .child(div().text_color(t.dim).child(icon(this.queueOpen ? 'chevron-down' : 'chevron-right', 14)))
        .child(div().max_w(320).min_w(0).truncate().text_color(problems && !working ? t.ansi1 : t.foreground).child(headline))
        .when(waiting > 0, el => el.child(div().flex_none().text_color(t.dim).child(`${waiting} queued`)))
        .child(div().flex_1().min_w(40).h(5).rounded(3).bg(t.border).child(div().h_full().rounded(3).bg(problems ? t.blocked : t.accent).w(`${pct.toFixed(1)}%`)))
        .when(Boolean(x && x.rate), el => el.child(div().flex_none().text_color(t.dim)
          .child(`${sizeText(x.rate)}/s${n.bytes > n.moved ? ' · ' + duration((n.bytes - n.moved) / x.rate) : ''}`)))
        .when(working, el => el.child(this.button(t, 'cancel-all', 'Cancel all', cx => this.rpc({ action: 'cancel_all' }, cx), { h: 22 })))
        .when(Boolean(problems), el => el.child(this.button(t, 'retry-all', 'Retry', cx => this.rpc({ action: 'retry' }, cx), { h: 22 })))
        .when(Boolean(finished && (problems || working)), el => el.child(this.button(t, 'clear', 'Clear', cx => this.rpc({ action: 'clear' }, cx),
          { tip: 'Remove finished items', h: 22 }))))
      .when(Boolean(this.queueOpen), el => el.child(v_flex().id('queue-list').h((this.height ?? 600) < 420 ? 96 : 150).px(6).pb(6).overflow_y_scrollbar()
        .children(rows.map(row))
        .when(jobs.length > rows.length, el => el.child(div().px(8).py(4).text_color(t.dim).child(`and ${jobs.length - rows.length} more…`)))));
  }

  // SSH | Split | SFTP, for the host tab this pane belongs to.
  modeSwitch(t, cx) {
    const state = tabState(this.tab);
    if (!state) return null;
    const seg = (id, label, iconName, tip) => {
      const on = state.mode === id;
      return h_flex().id(`sftp-mode-${id}`).h(22).px(this.width < 700 ? 5 : 7).gap(4).items_center().rounded(4).flex_none()
        .bg(on ? t.selected : '#00000000').text_color(on ? t.foreground : t.muted)
        .hover(s => s.bg(on ? t.selected : t.hover).text_color(t.foreground))
        .tooltip(tip).accessibility_label(tip)
        .on_click((_e, cx) => setMode(id, tabState(this.tab), cx))
        .child(icon(iconName, 12)).when(this.width >= 700, el => el.child(label));
    };
    return h_flex().flex_none().p(1).gap(1).items_center().rounded(6).border_1().border_color(t.border)
      .child(seg('ssh', 'SSH', 'terminal', 'SSH only (SFTP keeps running)'))
      .child(seg('split', 'Split', 'split', 'SSH on top, SFTP below'))
      .child(seg('sftp', 'SFTP', 'sftp', 'SFTP only (SSH keeps running)'));
  }

  // The one toolbar: status and summary, actions, and the mode switch.
  toolbar(t, cx) {
    const s = this.state;
    const local = this.panels.local.selection, remote = this.panels.remote.selection;
    const many = (list, one) => list.length > 1 ? `${list.length} items` : list.length ? `“${list[0].name}”` : one;
    const activePanel = this.panels[this.active];
    const chosen = activePanel.entry, picked = activePanel.selection, usable = this.usable(this.active);
    const connecting = this.starting || (this.conn && !s.ready && s.busy);
    const error = this.error || (s.error && s.error !== this.dismissedError ? s.error : null);
    const where = this.active === 'local' ? 'this computer' : this.alias;

    // Status: a dot (spinner while connecting) and the alias; a click connects or disconnects.
    const dot = connecting
      ? div().text_size(11).text_color(t.accent).child(SPINNER[0]).frames(SPINNER, 90)
      : div().w(7).h(7).flex_none().rounded_full()
        .bg(s.prompt || s.conflict ? t.blocked : s.ready ? t.done : error ? t.ansi1 : t.dim);
    const statusTip = s.prompt ? 'Waiting for the sign-in dialog'
      : s.ready ? `Connected to ${this.alias}${this.target ? ' (' + this.target + ')' : ''} · click to disconnect`
      : connecting ? `Connecting to ${this.alias}…` : `Not connected · click to connect`;
    const status = h_flex().id('sftp-status').h(26).px(6).gap(6).items_center().rounded(5).flex_none().min_w(0)
      .hover(s => s.bg(t.hover)).tooltip(statusTip).accessibility_label(statusTip)
      .on_click((_e, cx) => { if (this.starting) return; if (s.ready || connecting) this.disconnect(cx); else this.reconnect(cx); })
      .child(dot)
      .child(div().max_w(140).truncate().font_semibold().child(this.alias || 'SFTP'))
      .when(Boolean(this.target) && this.width > 900, el => el.child(div().max_w(180).truncate().text_color(t.dim).child(this.target)));

    // Summary: an error first, then the last message, then the selection.
    const marked = activePanel.marked.size;
    const msg = s.message && s.message !== 'Connected' ? s.message : null;
    const summary = error ? String(error).split('\n')[0]
      : msg || (marked > 1 ? `${marked} selected · ${sizeText(picked.reduce((sum, e) => sum + (e.dir ? 0 : e.size ?? 0), 0)) || '0 B'}`
        : chosen ? `${chosen.name}${chosen.dir ? '' : ' · ' + sizeText(chosen.size)}` : '');

    const tool = (id, glyph, fn, tip, active, danger = false) => this.button(t, id, '', fn,
      { glyph, tip, active, danger, h: 26 });
    return h_flex().px(8).h(38).flex_none().gap(4).items_center().border_b_1().border_color(t.border)
      .child(status)
      .when(Boolean(summary) && this.width > 560, el => el.child(h_flex().min_w(0).flex_shrink(1).gap(4).items_center()
        .child(div().text_color(t.border).child('·'))
        .child(div().min_w(0).truncate().text_size(11).text_color(error ? t.ansi1 : t.muted).tooltip(error ? String(error) : summary).child(summary))
        .when(Boolean(error), el => el.child(this.button(t, 'error-close', '', cx => { this.error = null; this.dismissedError = s.error; cx.notify(); },
          { glyph: icon('close', 12), tip: 'Hide', h: 20 })))))
      .child(div().flex_1().min_w(8))
      .child(tool('upload', div().child('↑'), cx => this.transfer('local', cx),
        local.length ? `Upload ${many(local)} to ${s.path} (F5)` : 'Upload: choose files or folders on the left', this.canTransfer && local.length > 0))
      .child(tool('download', div().child('↓'), cx => this.transfer('remote', cx),
        remote.length ? `Download ${many(remote)} to ${s.local_path} (F5)` : `Download: choose files or folders on ${this.alias}`, this.canTransfer && remote.length > 0))
      .child(tool('refresh', icon('refresh', 14), cx => this.list(this.active, '.', cx), `Refresh ${where} (Ctrl+R)`, usable))
      .child(tool('mkdir', div().child('+'), cx => this.showForm('mkdir', cx), `New folder on ${where} (F7)`, usable))
      .child(tool('rename', div().child('✎'), cx => this.showForm('rename', cx), 'Rename (F2)', usable && Boolean(chosen)))
      .child(tool('delete', div().child('✕'), cx => this.showForm('delete', cx),
        picked.length > 1 ? `Delete ${picked.length} items (Del)` : 'Delete (Del)', usable && picked.length > 0, true))
      .child(div().flex_1().min_w(8))
      .when(Boolean(this.tab), el => el.child(this.modeSwitch(t, cx) ?? div()));
  }

  render(cx) {
    const t = theme(), s = this.state;
    const conflict = s.conflict;
    const modal = conflict ? this.conflictCard(t, conflict) : this.viewer ? this.viewerCard(t) : this.form ? this.formCard(t) : null;
    const pad = (this.height ?? 600) < 420 ? 4 : 6;
    const panelWidth = (this.width - pad * 3) / 2;
    const queue = this.queue(t, cx);
    const inset = headerInset();

    return v_flex().id('sftp-root').size_full().min_h(0).relative().bg(t.chrome).text_color(t.foreground).text_size(12)
      .on_size_change((size, cx) => {
        const resized = Math.abs(size.width - this.width) > 8 || Math.abs(size.height - (this.height ?? 0)) > 8;
        this.height = size.height;
        if (resized) { this.width = size.width; cx.notify(); }
      })
      // A right press bubbles here last: open the menu its row (or list) asked for, where it was pressed.
      .on_mouse_down('right', (e, cx) => {
        if (!this.pendingMenu) return;
        this.menu = { ...this.pendingMenu, at: e.local_position ?? e.position };
        this.pendingMenu = null;
        cx.notify();
      })
      .when(inset > 0, el => el.child(div().h(inset).flex_none()))
      .child(this.toolbar(t, cx))
      .child(h_flex().flex_1().min_h(0).p(pad).gap(pad).items_stretch()
        .children(SIDES.map(side => this.panel(t, side, panelWidth))))
      .when(Boolean(queue), el => el.child(queue))
      .when(Boolean(this.menu && !modal), el => el.child(this.menuView(t)))
      .when(Boolean(modal), el => el.child(v_flex().id('sftp-modal').absolute().inset_0().items_center().justify_center().p(16)
        .bg(t.canvas).opacity(0.97).on_mouse_down('left', (_e, cx) => cx.stop_propagation()).child(modal)));
  }

  async close() {
    this.closed = true;
    this.generation++;
    if (this.dialog) { closeOverlay(this.dialog); this.dialog = null; }
    if (this.tab) {
      const all = { ...(shared('ssh-hosts.sftp.live') ?? {}) };
      if (this.tab in all) { delete all[this.tab]; setShared('ssh-hosts.sftp.live', all); }
    }
    for (const panel of Object.values(this.panels)) panel.release();
    this.name.release();
    if (this.conn) await this.post({ action: 'close' }).catch(() => {});
  }
}
