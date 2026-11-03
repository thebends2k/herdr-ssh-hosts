import { div, svg } from 'gpui-kit';
import { h_flex, v_flex, Editor, EditorState, Input, InputState, Scrollbar, v_virtual_list, VirtualListScrollHandle } from 'gpui-base';
import { appHome, exec, home, props, settings, shared, setShared, theme, window } from 'herdr';

// The SFTP view: this computer on the left, the server on the right.
// sftp_bridge.py owns the SSH connection and lists local folders too; this view
// talks to it over loopback HTTP: /rpc runs an action, /events waits until the
// state changes (progress and listings arrive at once, without polling), and
// password or host-key questions from OpenSSH arrive as `state.prompt`.

const ROW = 28;
const SIDES = ['local', 'remote'];
const WINDOWS = () => window()?.platform === 'windows';
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
const icon = name => svg(`mods/ssh-hosts/${name}.svg`).size(16).flex_none();
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
    this.config = home().replace(/[\\/]+$/, '') + '/.ssh/config';
    this.helper = appHome().replace(/[\\/]+$/, '') + '/mods/ssh-hosts/sftp_bridge.py';
    this.python = WINDOWS() ? 'python' : 'python3';
    this.state = { ...EMPTY };
    this.generation = 0;
    this.panels = { local: new Panel('local', this, cx), remote: new Panel('remote', this, cx) };
    this.active = 'remote';
    this.name = InputState.new({ placeholder: 'Name' });
    this.secret = InputState.new({ placeholder: '' });
    this.secret.set_masked(true);
    this.name.on('submit', (_e, cx) => this.submit(cx));
    this.secret.on('submit', (_e, cx) => this.answer(this.secret.value(), cx));
    this.width = 1000;
    this.jobs = [];
    this.viewer = null;
    this.queueOpen = load('queueOpen', true);
    this.connect(cx);
  }

  // --- talking to the bridge ---------------------------------------------

  headers(conn = this.conn) {
    return { Authorization: 'Bearer ' + conn.token, 'Content-Type': 'application/json' };
  }

  connect(cx) {
    if (this.starting) return;
    this.starting = true;
    this.error = null;
    this.state = { ...EMPTY };
    this.panels.remote.entries = [];
    const start = load('path:' + this.alias, '.');
    cx.spawn(async cx => {
      try {
        const result = await exec(this.python, [this.helper, 'start', this.alias, this.config, start]);
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
      finally { this.starting = false; if (!this.closed) cx.notify(); }
    });
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
            this.error = 'Lost the connection to the SFTP browser. Press Connect to retry.';
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
    if (state.prompt && state.prompt.id !== old.prompt?.id) {
      this.secret.set_value('');
      if (['secret', 'passphrase'].includes(state.prompt.kind)) {
        this.retry = this.answeredSecret === true;
        this.secret.focus();
      }
    }
    if (state.ready && !old.ready) this.answeredSecret = false;
    if (state.conflict && state.conflict.id !== old.conflict?.id) this.applyAll = false;
    if (state.message && state.message !== old.message && !state.busy && this.form) {
      this.form = null;
      this.panels[this.active].focus.focus();  // back to the list the form was for
    }
    this.state = state;
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

  answer(value, cx) {
    const prompt = this.state.prompt;
    if (!prompt) return;
    if (['secret', 'passphrase'].includes(prompt.kind) && value != null) this.answeredSecret = true;
    this.rpc({ action: 'answer', id: prompt.id, value }, cx);
    this.secret.set_value('');
  }

  disconnect(cx) {
    const conn = this.conn;
    this.generation++;
    this.conn = null;
    this.state = { ...EMPTY };
    for (const panel of Object.values(this.panels)) { panel.entries = []; panel.reset(); }
    this.jobs = [];
    this.viewer = null;
    this.form = null;
    this.error = null;
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
    if (this.state.prompt || this.state.conflict) return;
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

  button(t, id, title, fn, { active = true, danger = false, primary = false, glyph = null, tip = null, on = false } = {}) {
    return h_flex().id('sftp-' + id).h(28).px(glyph && !title ? 0 : 10).when(glyph && !title, el => el.w(28).justify_center())
      .gap(6).items_center().rounded(6).flex_none()
      .when(!primary, el => el.border_1().border_color(on ? t.accent : t.border))
      .bg(primary && active ? danger ? t.ansi1 : t.solid : on ? t.selected : '#00000000')
      .role('button').accessibility_label(tip || title).when(Boolean(tip), el => el.tooltip(tip)).disabled(!active)
      .text_color(!active ? t.dim : primary ? t.solid_foreground : danger ? t.ansi1 : t.foreground)
      .when(active, el => el.hover(s => s.bg(primary ? t.solid : t.hover)).on_click((_e, cx) => fn(cx)))
      .when(Boolean(glyph), el => el.child(glyph)).when(Boolean(title), el => el.child(title));
  }

  input(t, state, label, enabled = true) {
    return Input.new(state).h(28).px(8).min_w(0).flex_1().rounded(6).border_1().border_color(t.input)
      .bg(t.background).text_color(t.foreground).text_size(12).accessibility_label(label).disabled(!enabled);
  }

  card(t, title, ...children) {
    return v_flex().w(440).max_w('100%').p(16).gap(10).rounded(10).bg(t.popover).border_1().border_color(t.border)
      .child(div().font_semibold().text_size(13).child(title)).children(children);
  }

  // A question from OpenSSH: password, passphrase, host key or approval.
  promptCard(t, prompt) {
    const mono = settings().font_family ?? 'JetBrains Mono';
    const text = div().text_color(t.muted).whitespace_normal().font_family(mono).text_size(11).child(prompt.text);
    const actions = (...items) => h_flex().gap(8).justify_end().children(items);
    if (prompt.kind === 'hostkey') {
      return this.card(t, 'Verify the server', text,
        div().text_color(t.foreground).whitespace_normal().child('This is the first connection to this server, or its fingerprint changed. Compare it with the server’s before trusting it.'),
        actions(this.button(t, 'hk-no', 'Reject', cx => this.answer('no', cx)),
          this.button(t, 'hk-yes', 'Trust and connect', cx => this.answer('yes', cx), { primary: true })));
    }
    if (prompt.kind === 'approve' || prompt.kind === 'info') {
      return this.card(t, 'OpenSSH', text,
        actions(this.button(t, 'ap-no', 'Cancel', cx => this.answer(null, cx)),
          ...(prompt.kind === 'approve' ? [this.button(t, 'ap-yes', 'Accept', cx => this.answer('', cx), { primary: true })] : [])));
    }
    return this.card(t, prompt.kind === 'passphrase' ? 'Key passphrase' : 'Password', text,
      ...(this.retry ? [div().text_color(t.ansi1).child('Not accepted. Try again.')] : []),
      this.input(t, this.secret, prompt.text).flex_none().w_full(),
      div().text_size(11).text_color(t.dim).child('Sent only to OpenSSH; never stored.'),
      actions(this.button(t, 'pw-cancel', 'Cancel', cx => this.answer(null, cx)),
        this.button(t, 'pw-ok', 'Connect', cx => this.answer(this.secret.value(), cx), { primary: true })));
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
    return h_flex().id(`path-${side}`).flex_1().min_w(0).h(28).px(6).gap(2).items_center().rounded(6)
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
      return block('Could not start the browser', firstLine(this.error),
        this.button(t, `retry-start-${side}`, 'Retry', cx => this.connect(cx), { primary: true }));
    }
    if (remote && !s.ready) {
      if (connecting) return block(`Connecting to ${this.alias}…`,
        s.prompt ? '' : 'If the server asks for a password or to confirm its fingerprint, a dialog will appear.', null, true);
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
    const head = (key, label, w) => h_flex().id(`sort-${side}-${key}`).when(Boolean(w), el => el.w(w).justify_end())
      .when(!w, el => el.flex_1()).gap(4).items_center().rounded(4).hover(s => s.text_color(t.foreground))
      .on_click((_e, cx) => this.sortBy(side, key, cx))
      .child(label).when(panel.sort.key === key, el => el.child(panel.sort.dir > 0 ? '▲' : '▼'));
    const shownCount = entries.length, total = panel.entries.length;
    const focused = panel.focus.is_focused();
    const marked = panel.marked.size;

    return v_flex().id(`panel-${side}`).flex_1().min_w(0).min_h(0).rounded(8).border_1()
      .border_color(this.active === side ? t.accent : t.border).bg(t.background)
      .on_mouse_down('left', (_e, cx) => { if (this.active !== side) { this.active = side; panel.focus.focus(); cx.notify(); } })
      .when(remote, el => el.on_drop((event, cx) => {
        if (!this.canTransfer || !event.paths?.length) return;
        this.rpc({ action: 'enqueue', kind: 'upload', paths: event.paths }, cx);
      }))
      .child(h_flex().px(10).pt(8).gap(6).items_center()
        .child(div().text_color(t.muted).child(icon(remote ? 'sftp' : 'folder')))
        .child(div().font_semibold().truncate().child(remote ? this.alias : 'This computer'))
        .when(remote && Boolean(this.target), el => el.child(div().min_w(0).truncate().text_color(t.dim).text_size(11).child(this.target)))
        .child(div().flex_1())
        .child(this.button(t, `hidden-${side}`, '.*', cx => { panel.showHidden = !panel.showHidden; panel.save(); cx.notify(); },
          { on: panel.showHidden, tip: panel.showHidden ? 'Hide hidden files' : 'Show hidden files' }))
        .child(div().w(width > 460 ? 150 : 110).flex_none().child(this.input(t, panel.search, 'Filter by name', usable))))
      .child(h_flex().px(10).py(6).gap(6).items_center()
        .child(this.button(t, `up-${side}`, '', cx => this.list(side, '..', cx), { active: usable, glyph: div().child('↑'), tip: 'Parent folder' }))
        .child(this.button(t, `refresh-${side}`, '', cx => this.list(side, '.', cx), { active: usable, glyph: icon('refresh'), tip: 'Refresh' }))
        .child(this.pathBar(t, side, path)))
      .child(h_flex().px(18).h(22).flex_none().gap(8).items_center().text_size(11).text_color(t.dim)
        .child(div().w(16)).child(head('name', 'Name')).child(head('size', 'Size', 72))
        .when(cols.date, el => el.child(head('mtime', 'Modified', 112)))
        .when(cols.perms, el => el.child(div().w(80).text_right().child('Permissions'))))
      .child(div().flex_1().min_h(0).relative().mx(10)
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
        .when(Boolean(empty), el => el.child(empty)))
      .child(h_flex().px(12).h(26).flex_none().items_center().text_size(11).text_color(t.dim)
        .child(div().flex_1().truncate().child(!this.conn || (remote && !s.ready) ? ''
          : `${shownCount === total ? total : `${shownCount} of ${total}`} items`
            + ((remote ? s.limited : s.local_limited) ? ' (list truncated)' : '')
            + (marked > 1 ? ` · ${marked} selected (${sizeText(panel.selection.reduce((n, e) => n + (e.dir ? 0 : e.size ?? 0), 0)) || '0 B'})`
              : panel.entry ? ` · “${panel.entry.name}”${panel.entry.dir ? '' : ' ' + sizeText(panel.entry.size)}` : ''))));
  }

  // The transfer queue: totals, the current file and, unfolded, one row per file.
  queue(t) {
    const s = this.state, x = s.transfer, n = s.totals;
    const jobs = this.jobs ?? [];
    if (!n || !n.files && !n.folders && !jobs.length) {
      const text = s.busy ? (s.ready ? 'Working…' : 'Connecting…') : s.message
        || 'Double-click: open a folder or send the file to the other side · Drag files or folders onto the server panel to upload them';
      return h_flex().px(12).h(32).flex_none().items_center().border_t_1().border_color(t.border).text_color(t.muted)
        .child(div().flex_1().truncate().child(text));
    }
    const pct = n.bytes ? Math.min(100, (n.moved / n.bytes) * 100) : 0;
    const problems = n.failed + n.cancelled, finished = n.done + n.skipped + problems;
    const summary = n.waiting || n.folders
      ? `${n.done + n.skipped} of ${n.files} files${n.folders ? ' (scanning folders…)' : ''} · ${sizeText(n.moved)} of ${sizeText(n.bytes)}`
      : `Finished: ${n.done} transferred${n.skipped ? `, ${n.skipped} skipped` : ''}`
        + (problems ? `, ${problems} with problems` : '');
    const rows = jobs.slice(0, 120);
    const color = { done: t.done, failed: t.ansi1, cancelled: t.dim, skipped: t.dim, conflict: t.blocked, running: t.accent, queued: t.muted };
    const row = job => {
      const running = x && x.id === job.id;
      const label = running && x.total ? `${Math.floor((x.done / x.total) * 100)} %` : job.renamed ? `Done as “${job.renamed}”` : STATUS[job.status];
      return h_flex().id('job-' + job.id).h(26).px(8).gap(8).items_center().rounded(5).flex_none()
        .when(Boolean(job.error), el => el.tooltip(job.error))
        .child(div().w(14).text_color(t.dim).child(job.kind === 'upload' ? '↑' : '↓'))
        .child(div().text_color(job.dir ? t.accent : t.muted).child(icon(job.dir ? 'folder' : 'file')))
        .child(div().flex_1().min_w(0).truncate().child(job.name))
        .child(div().w(72).text_right().text_color(t.muted).child(sizeText(job.size)))
        .child(div().w(150).text_right().truncate().text_color(color[job.status]).child(job.error && job.status !== 'skipped' ? `${label}: ${job.error}` : label))
        .child(div().w(28).flex_none().when(job.status === 'queued' || running, el => el.child(
          this.button(t, 'jc-' + job.id, '', cx => this.rpc({ action: 'cancel_job', id: job.id }, cx), { glyph: icon('close'), tip: 'Cancel' })))
          .when(job.status === 'failed' || job.status === 'cancelled', el => el.child(
            this.button(t, 'jr-' + job.id, '', cx => this.rpc({ action: 'retry', id: job.id }, cx), { glyph: icon('refresh'), tip: 'Retry' }))));
    };
    return v_flex().flex_none().border_t_1().border_color(t.border)
      .child(h_flex().px(12).h(40).gap(10).items_center()
        .child(this.button(t, 'queue-fold', '', cx => { this.queueOpen = !this.queueOpen; save('queueOpen', this.queueOpen); cx.notify(); },
          { glyph: icon(this.queueOpen ? 'chevron-down' : 'chevron-right'), tip: this.queueOpen ? 'Hide the queue' : 'Show the queue' }))
        .child(div().max_w(380).truncate().text_color(t.foreground).child(summary))
        .child(div().flex_1().min_w(60).h(6).rounded(3).bg(t.border).child(div().h_full().rounded(3).bg(t.accent).w(`${pct.toFixed(1)}%`)))
        .child(div().w(160).text_right().truncate().text_color(t.dim).child(x && x.rate
          ? `${sizeText(x.rate)}/s${n.bytes > n.moved ? ' · ' + duration((n.bytes - n.moved) / x.rate) : ''}` : ''))
        .when(Boolean(n.waiting || n.folders), el => el.child(this.button(t, 'cancel-all', 'Cancel all', cx => this.rpc({ action: 'cancel_all' }, cx))))
        .when(Boolean(problems), el => el.child(this.button(t, 'retry-all', 'Retry', cx => this.rpc({ action: 'retry' }, cx))))
        .when(Boolean(finished), el => el.child(this.button(t, 'clear', 'Clear', cx => this.rpc({ action: 'clear' }, cx),
          { tip: 'Remove finished items from the list' }))))
      .when(Boolean(this.queueOpen), el => el.child(v_flex().id('queue-list').h(170).px(10).pb(8).overflow_y_scrollbar()
        .children(rows.map(row))
        .when(jobs.length > rows.length, el => el.child(div().px(8).py(4).text_color(t.dim).child(`and ${jobs.length - rows.length} more…`)))));
  }

  render(cx) {
    const t = theme(), s = this.state;
    const local = this.panels.local.selection, remote = this.panels.remote.selection;
    const many = (list, one) => list.length > 1 ? `${list.length} items` : list.length ? `“${list[0].name}”` : one;
    const conflict = s.conflict;
    const modal = s.prompt ? this.promptCard(t, s.prompt) : conflict ? this.conflictCard(t, conflict) : this.viewer ? this.viewerCard(t) : this.form ? this.formCard(t) : null;
    const error = this.error || (s.error && s.error !== this.dismissedError ? s.error : null);
    const connecting = this.starting || (this.conn && !s.ready && s.busy);
    const chosen = this.panels[this.active].entry, picked = this.panels[this.active].selection, usable = this.usable(this.active);
    const panelWidth = (this.width - 36) / 2;

    const toolbar = h_flex().px(12).h(48).flex_none().gap(6).items_center().border_b_1().border_color(t.border)
      .child(this.button(t, 'upload', local.length > 1 ? `Upload ${local.length} →` : 'Upload →', cx => this.transfer('local', cx),
        { active: this.canTransfer && local.length > 0, tip: local.length ? `Upload ${many(local)} to ${s.path} (F5)` : 'Choose files or folders on This computer' }))
      .child(this.button(t, 'download', remote.length > 1 ? `← Download ${remote.length}` : '← Download', cx => this.transfer('remote', cx),
        { active: this.canTransfer && remote.length > 0, tip: remote.length ? `Download ${many(remote)} to ${s.local_path} (F5)` : `Choose files or folders on ${this.alias}` }))
      .child(div().w(1).h(20).mx(4).bg(t.border))
      .child(this.button(t, 'mkdir', 'New folder', cx => this.showForm('mkdir', cx), { active: usable, tip: 'New folder (F7)' }))
      .child(this.button(t, 'rename', 'Rename', cx => this.showForm('rename', cx), { active: usable && Boolean(chosen), tip: 'Rename (F2)' }))
      .child(this.button(t, 'delete', picked.length > 1 ? `Delete ${picked.length}` : 'Delete', cx => this.showForm('delete', cx),
        { active: usable && picked.length > 0, danger: true, tip: 'Delete (Del)' }))
      .child(div().flex_1())
      .child(div().text_color(s.ready ? t.done : t.dim).child(s.ready ? 'connected' : connecting ? 'connecting…' : 'not connected'))
      .child(this.button(t, 'connection', s.ready || connecting ? 'Disconnect' : this.conn ? 'Reconnect' : 'Connect',
        cx => (s.ready || connecting) ? this.disconnect(cx) : this.reconnect(cx), { active: !this.starting, primary: !s.ready && !connecting }));

    return v_flex().id('sftp-root').size_full().min_h(0).relative().bg(t.chrome).text_color(t.foreground).text_size(12)
      .on_size_change((size, cx) => {
        this.height = size.height;
        if (Math.abs(size.width - this.width) > 8) { this.width = size.width; cx.notify(); }
      })
      // A right press bubbles here last: open the menu its row (or list) asked for, where it was pressed.
      .on_mouse_down('right', (e, cx) => {
        if (!this.pendingMenu) return;
        this.menu = { ...this.pendingMenu, at: e.local_position ?? e.position };
        this.pendingMenu = null;
        cx.notify();
      })
      .child(toolbar)
      .when(Boolean(error), el => el.child(h_flex().mx(12).mt(8).px(12).py(8).gap(8).items_start().rounded(6).bg(t.surface)
        .border_1().border_color(t.ansi1)
        .child(v_flex().flex_1().min_w(0).gap(4)
          .child(div().whitespace_normal().text_color(t.ansi1).child(String(error).split('\n')[0]))
          .when(String(error).includes('\n'), el => el.child(div().whitespace_normal().text_size(11).text_color(t.muted)
            .font_family(settings().font_family ?? 'JetBrains Mono').child(String(error).split('\n').slice(1, 6).join('\n')))))
        .child(this.button(t, 'error-close', '', cx => { this.error = null; this.dismissedError = s.error; cx.notify(); },
          { glyph: icon('close'), tip: 'Hide' }))))
      .child(h_flex().flex_1().min_h(0).p(12).gap(12).items_stretch()
        .children(SIDES.map(side => this.panel(t, side, panelWidth))))
      .child(this.queue(t))
      .when(Boolean(this.menu && !modal), el => el.child(this.menuView(t)))
      .when(Boolean(modal), el => el.child(v_flex().id('sftp-modal').absolute().inset_0().items_center().justify_center().p(16)
        .bg(t.canvas).opacity(0.97).on_mouse_down('left', (_e, cx) => cx.stop_propagation()).child(modal)));
  }

  async close() {
    this.closed = true;
    this.generation++;
    for (const panel of Object.values(this.panels)) panel.release();
    this.name.release();
    this.secret.release();
    if (this.conn) await this.post({ action: 'close' }).catch(() => {});
  }
}
