import { View, div, svg } from 'gpui-kit';
import { v_flex, h_flex, Input, InputState } from 'gpui-base';
import { checking, closeOverlay, exec, focused, openOverlay, panes, placement, props, readTextFile, run, setShared, shared, spaces, theme, watchFolder, window } from 'herdr';
import { parseConfig, groupHosts, target, launchPlan } from './config.js';
import { CONFIG, hidePanel, liveStatus, panelPath, panelShown, rememberSession, sessions, setMode, shellArgv, showPanel, tabState } from './session.js';
import { SftpPanel } from './sftp.js';

// One mod, five faces, chosen by its props:
//   { mode: 'sftp' }  the SFTP pane of a host tab (sftp.js)
//   { auth: {...} }   the sign-in dialog the SFTP pane opens for OpenSSH's questions
//   { bar: true }     the floating pill: SFTP status and SSH / Split / SFTP
//   popup             the host picker (from the row, a tab bar button or `mod.open`)
//   { panel: true }   the same picker as a side panel, in a layout that holds one
//   (none)            the 32 px SSH row for a sidebar

const icon = (name, size = 16) => svg('mods/ssh-hosts/' + name + '.svg').w(size).h(size).flex_none();
// Kept in shared state: unlike localStorage it lasts across popups and restarts.
const recall = (key, fallback) => shared('ssh-hosts.' + key) ?? fallback;
const remember = (key, value) => setShared('ssh-hosts.' + key, value);
const ROW = 40, HEAD = 26, WIDTH = 360, COMPACT = 120;
const SPINNER = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

export default class SSHHosts extends View {
  init(initial, cx) {
    const p = props() ?? {};
    if (p.mode === 'sftp') {
      this.sftp = new SftpPanel();
      this.sftp.init(cx);
      return;
    }
    if (p.auth) return this.initAuth(p.auth);
    if (p.bar) { this.bar = true; return; }
    // The shortcut (`mod.open`) opens an overlay; with a side panel in the
    // layout, show that instead and close the overlay at once.
    if (p.overlay && !p.popup && showPanel()) {
      this.redirected = true;
      closeOverlay(p.overlay);
      return;
    }
    this.panel = Boolean(p.panel);
    this.path = CONFIG();
    this.folder = this.path.replace(/[\\/]config$/, '');
    // `mod.open ssh-hosts` (a key) opens it as an overlay too, without `popup`.
    this.popup = Boolean(p.popup || p.overlay || p.panel);  // the picker, in a popup or a panel
    this.hosts = [];
    this.error = null;
    this.loading = true;
    if (!checking()) {
      this.refresh(cx);
      // Reload when the file changes; a timer only if the folder cannot be watched.
      cx.spawn(async cx => {
        try { for (;;) { await watchFolder(this.folder); this.refresh(cx); } }
        catch { cx.timer.every(30000, cx => this.refresh(cx)); }
      });
    } else {
      this.loading = false;
    }
    if (this.popup) {
      this.search = InputState.new({ placeholder: 'Search host…' });
      this.search.on('change', (_e, cx) => { this.query = this.search.value().trim().toLowerCase(); this.cursor = 0; cx.notify(); });
      // Enter: the host's tab (opened or reopened) · Ctrl+Enter: another session.
      this.search.on('submit', (e, cx) => {
        const entry = this.rows?.[this.cursor];
        if (entry) this.openHost(entry.alias, Boolean(e?.secondary), cx);
      });
      this.query = '';
      this.cursor = 0;
      if (!this.panel) this.search.focus();
    }
  }

  refresh(cx) {
    if (this.busy) return;
    this.busy = true;
    cx.spawn(async cx => {
      try {
        const text = await readTextFile(this.path);
        if (text === null) throw new Error('~/.ssh/config not found');
        this.hosts = parseConfig(text);
        this.error = null;
        remember('popupHeight', SSHHosts.height(this.hosts));
      } catch (error) {
        this.hosts = [];
        this.error = String(error.message ?? error);
      } finally {
        this.busy = false;
        this.loading = false;
        cx.notify();
      }
    });
  }

  // --- opening ---------------------------------------------------------------

  // The tab already open for this host, if any.
  session(alias) {
    const known = sessions();
    for (const space of spaces()) {
      const tab = space.tabs.find(t => known[t.id]?.alias === alias || (t.named && (t.name === alias || t.name === `SFTP · ${alias}`)));
      if (tab) return { space, tab };
    }
    return null;
  }

  used(alias) {
    remember('recent', [alias, ...recall('recent', []).filter(a => a !== alias)].slice(0, 8));
  }

  done() { if (props()?.overlay) closeOverlay(props().overlay); }

  // One tab per host: SSH on top (with the keyboard), SFTP below. If the host
  // already has one, go back to it, unless `fresh` asks for another.
  openHost(alias, fresh = false, cx = null) {
    if (this.launching) return;
    this.used(alias);
    const found = !fresh && this.session(alias);
    if (found) {
      this.done();
      run('space.select', { id: found.space.id });
      run('tab.select', { id: found.tab.id });
      return;
    }
    const hostTarget = target(this.hosts.find(h => h.alias === alias) ?? {});
    const before = new Set(spaces().flatMap(s => s.tabs.map(t => t.id)));
    const plan = launchPlan(alias, shellArgv(alias), spaces().filter(s => !s.machine));
    run(plan.command, plan.args);
    if (!cx) return this.done();
    this.launching = true;
    cx.spawn(async cx => {
      try {
        let tab = null, sshPane = null;
        for (let i = 0; i < 60 && !sshPane; i++) {
          await cx.sleep(20);
          tab = spaces().flatMap(s => s.tabs).find(t => !before.has(t.id) && t.named && t.name === alias) ?? null;
          sshPane = tab && panes().find(p => p.tab === tab.id && p.terminal);
        }
        if (!sshPane) return;
        rememberSession(tab.id, { alias, target: hostTarget });
        run('pane.split', { direction: 'down', pane: sshPane.pane, mod: 'ssh-hosts',
          props: { mode: 'sftp', alias, target: hostTarget, tab: tab.id } });
        await cx.sleep(30);
        run('pane.focus', { pane: sshPane.pane });
      } finally {
        this.launching = false;
        this.done();
      }
    });
  }

  editConfig() {
    this.done();
    const platform = window()?.platform;
    const [command, args] = platform === 'windows' ? ['notepad.exe', [this.path]]
      : platform === 'macos' ? ['open', ['-t', this.path]] : ['xdg-open', [this.path]];
    exec(command, args).catch(() => {});
  }

  togglePin(alias, cx) {
    const pinned = recall('pinned', []);
    remember('pinned', pinned.includes(alias) ? pinned.filter(a => a !== alias) : [...pinned, alias]);
    cx.notify();
  }

  async close() {
    if (this.sftp) return this.sftp.close();
    if (this.auth) return this.closeAuth();
    this.search?.release();
  }

  // --- the sign-in dialog ------------------------------------------------------
  // The SFTP pane opens it (a centered dialog) when OpenSSH asks something.
  // The answer goes straight to the bridge; Esc or closing it is Cancel.

  initAuth(auth) {
    this.auth = auth;
    this.secret = InputState.new({ placeholder: '' });
    this.secret.set_masked(true);
    this.secret.on('submit', (_e, cx) => this.reply(this.secret.value(), cx));
    if (['secret', 'passphrase', 'server'].includes(auth.prompt.kind)) this.secret.focus();
  }

  reply(value, cx) {
    if (this.answered) return;
    this.answered = true;
    const { url, token, prompt } = this.auth;
    cx.spawn(async () => {
      await fetch(url + '/rpc', { method: 'POST', body: JSON.stringify({ action: 'answer', id: prompt.id, value }),
        headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' } }).catch(() => {});
      closeOverlay(props().overlay);
    });
  }

  async closeAuth() {
    this.secret.release();
    if (this.answered) return;
    this.answered = true;
    const { url, token, prompt } = this.auth;
    await fetch(url + '/rpc', { method: 'POST', body: JSON.stringify({ action: 'answer', id: prompt.id, value: null }),
      headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' } }).catch(() => {});
  }

  authButton(t, id, label, fn, primary = false, danger = false) {
    return h_flex().id(id).h(28).px(12).items_center().rounded(6).flex_none()
      .when(!primary, el => el.border_1().border_color(t.border).hover(s => s.bg(t.hover)))
      .when(primary, el => el.bg(danger ? t.ansi1 : t.solid).text_color(t.solid_foreground).hover(s => s.opacity(0.9)))
      .on_click((_e, cx) => fn(cx)).child(label);
  }

  renderAuth(t) {
    const { prompt, alias, target: where, retry } = this.auth;
    const text = div().text_color(t.muted).whitespace_normal().font_family('JetBrains Mono').text_size(11).child(prompt.text);
    const actions = (...items) => h_flex().gap(8).justify_end().pt(4).children(items);
    const head = (title, sub) => v_flex().gap(2)
      .child(h_flex().gap(8).items_center().child(div().text_color(t.accent).child(icon('server'))).child(div().font_semibold().text_size(14).child(title)))
      .child(div().text_size(11).text_color(t.dim).child(sub));
    const sub = `${alias}${where ? ' · ' + where : ''} · SSH and SFTP share this sign-in`;
    let body;
    if (prompt.kind === 'hostkey') {
      body = [head('Verify the server', sub), text,
        div().whitespace_normal().child('This is the first connection to this server, or its fingerprint changed. Compare it with the server’s before trusting it.'),
        actions(this.authButton(t, 'hk-no', 'Reject', cx => this.reply('no', cx)),
          this.authButton(t, 'hk-yes', 'Trust and connect', cx => this.reply('yes', cx), true))];
    } else if (prompt.kind === 'approve' || prompt.kind === 'info') {
      body = [head('OpenSSH', sub), text,
        actions(this.authButton(t, 'ap-no', prompt.kind === 'info' ? 'Close' : 'Cancel', cx => this.reply(null, cx)),
          ...(prompt.kind === 'approve' ? [this.authButton(t, 'ap-yes', 'Accept', cx => this.reply('', cx), true)] : []))];
    } else {
      // 'server': the server's own words (keyboard-interactive), never dressed as OpenSSH's.
      const title = { passphrase: 'Key passphrase', server: `${alias} asks` }[prompt.kind] ?? 'Password';
      body = [head(title, sub), text,
        ...(retry ? [div().text_color(t.ansi1).child('Not accepted. Try again.')] : []),
        Input.new(this.secret).h(30).px(8).w_full().rounded(6).border_1().border_color(t.input).bg(t.background)
          .text_color(t.foreground).text_size(12).accessibility_label(prompt.text),
        div().text_size(11).text_color(t.dim).child('Sent only to OpenSSH; never written to disk.'),
        actions(this.authButton(t, 'pw-cancel', 'Cancel', cx => this.reply(null, cx)),
          this.authButton(t, 'pw-ok', 'Connect', cx => this.reply(this.secret.value(), cx), true))];
    }
    return v_flex().id('ssh-auth').w(440).p(18).gap(10).bg(t.popover).text_color(t.foreground).text_size(12).children(body);
  }

  // --- what the popup lists ---------------------------------------------------

  // Sections in order: pinned, recent, then the config's groups; or, while
  // searching, every match. Each host appears once.
  sections() {
    const byAlias = new Map(this.hosts.map(h => [h.alias, h]));
    if (this.query) {
      const q = this.query;
      const hits = this.hosts.filter(h => [h.alias, h.host, h.user, h.group].some(v => v && v.toLowerCase().includes(q)));
      return [{ name: hits.length ? null : '', hosts: hits }];
    }
    const pinned = recall('pinned', []).map(a => byAlias.get(a)).filter(Boolean);
    const recent = recall('recent', []).map(a => byAlias.get(a)).filter(h => h && !pinned.includes(h)).slice(0, 4);
    const out = [];
    if (pinned.length) out.push({ name: 'Pinned', hosts: pinned, special: true });
    // Recents only help when there is a list to skip.
    if (recent.length && this.hosts.length > 6) out.push({ name: 'Recent', hosts: recent, special: true });
    const listed = new Set(out.flatMap(s => s.hosts));
    for (const group of groupHosts(this.hosts)) {
      const rest = group.hosts.filter(h => !listed.has(h));
      if (rest.length) out.push({ name: group.name, hosts: rest });
    }
    return out;
  }

  // The popup's height for its content, between a floor and a ceiling.
  static height(hosts) {
    const groups = groupHosts(hosts);
    const pinned = recall('pinned', []).length;
    const heads = groups.filter(g => g.name).length + (pinned ? 1 : 0) + (hosts.length > 6 && recall('recent', []).length ? 1 : 0);
    const rows = hosts.length + Math.min(4, hosts.length > 6 ? recall('recent', []).length : 0);
    return Math.max(220, Math.min(560, 52 + 36 + heads * (HEAD + 8) + rows * ROW + 16));
  }

  // Opens the picker: the layout's side panel if it has one, else a popup
  // under the pointer (the row and tab bar buttons).
  static openPicker() {
    if (showPanel()) return;
    const height = Number(shared('ssh-hosts.popupHeight')) || 420;
    openOverlay({ mod: 'ssh-hosts', props: { popup: true, height }, kind: 'popup', width: WIDTH, height });
  }

  // --- drawing ----------------------------------------------------------------

  row(t, entry, index) {
    const alias = entry.alias, chosen = index === this.cursor;
    const open = this.session(alias);
    const pinned = recall('pinned', []).includes(alias);
    const where = target(entry);
    const tip = open ? 'Go to its tab (Enter) · Ctrl+Enter or Ctrl+click: another session' : 'Open SSH + SFTP (Enter)';
    return h_flex().id('ssh-' + alias).h(ROW).flex_none().px(10).gap(10).items_center().rounded(6)
      .bg(chosen ? t.selected : '#00000000').text_color(t.foreground).tooltip(tip)
      .on_hover((hovered, cx) => { if (hovered && this.cursor !== index) { this.cursor = index; cx.notify(); } })
      .on_mouse_down('left', e => { this.pressed = e.modifiers ?? {}; })
      .on_click((_e, cx) => this.openHost(alias, Boolean(this.pressed?.control || this.pressed?.platform), cx))
      .child(div().text_color(t.dim).child(icon('server')))
      .child(v_flex().flex_1().min_w(0)
        .child(h_flex().gap(6).items_center().min_w(0)
          .child(div().truncate().child(alias))
          .when(Boolean(open), el => el.child(div().w(6).h(6).flex_none().rounded(3).bg(t.done))))
        .when(Boolean(where || entry.jump), el => el.child(h_flex().gap(6).min_w(0).text_size(11).text_color(t.dim)
          .when(Boolean(where), el => el.child(div().truncate().child(where)))
          .when(Boolean(entry.jump), el => el.child(div().flex_none().px(4).rounded(3).border_1().border_color(t.border)
            .tooltip(`Jumps via ${entry.jump}`).child('jump'))))))
      .when(chosen, el => el
        .child(h_flex().id('pin-' + alias).w(26).h(26).flex_none().items_center().justify_center().rounded(5)
          .text_color(pinned ? t.accent : t.dim).hover(s => s.bg(t.hover).text_color(t.foreground))
          .tooltip(pinned ? 'Unpin' : 'Pin to top').accessibility_label(pinned ? 'Unpin' : 'Pin to top')
          .on_mouse_down('left', (_e, cx) => cx.stop_propagation())
          .on_click((_e, cx) => { cx.stop_propagation(); this.togglePin(alias, cx); })
          .child(pinned ? '★' : '☆')))
      // Same 26 px box as the button: the star never moves when the row is hovered.
      .when(!chosen && pinned, el => el.child(h_flex().w(26).h(26).flex_none().items_center().justify_center()
        .text_color(t.dim).child('★')));
  }

  list(t) {
    const sections = this.sections();
    const folded = recall('folded', {});
    this.rows = [];
    const body = v_flex().id('ssh-list').flex_1().min_h(0).px(8).pb(8).overflow_y_scrollbar();
    if (this.loading) return body.child(div().p(12).text_color(t.dim).child('Loading hosts…'));
    if (this.error) return body.child(div().p(12).whitespace_normal().text_color(t.ansi1).child(this.error));
    if (!this.hosts.length) return body.child(div().p(12).whitespace_normal().text_color(t.dim)
      .child('No aliases in ~/.ssh/config. Add a “Host” block and it will show up here.'));
    if (this.query && !sections[0].hosts.length) return body.child(div().p(12).text_color(t.dim).child(`No host matches “${this.query}”`));
    return body.children(sections.map(section => {
      const name = section.name;
      // While searching every group is open: a hit must never hide in a folded one.
      const closed = Boolean(name && !section.special && folded[name]);
      const rows = closed ? [] : section.hosts.map(entry => this.row(t, entry, this.rows.push(entry) - 1));
      return v_flex().flex_none().mt(name ? 6 : 2)
        .when(Boolean(name), el => el.child(h_flex().id('group-' + name).h(HEAD + 2).px(8).gap(6).items_center().rounded(5)
          .bg(section.special ? '#00000000' : t.hover)
          .text_size(11).text_color(/prod/i.test(name) ? t.ansi1 : t.dim)
          .when(!section.special, el => el.hover(s => s.text_color(t.foreground)).on_click((_e, cx) => {
            remember('folded', { ...folded, [name]: !folded[name] });
            cx.notify();
          }).child(icon(closed ? 'chevron-right' : 'chevron-down')).child(icon('folder')))
          .child(div().font_semibold().child(section.special ? name : name.toUpperCase()))
          .child(div().child(`· ${section.hosts.length}`))))
        .when(rows.length > 0, el => el.child(v_flex().flex_none()
          .when(!section.special, el => el.ml(16).pl(4).border_l_1().border_color(t.border))
          .children(rows)));
    }));
  }

  // The floating pill: on host tabs only. SFTP status, then SSH / Split / SFTP.
  renderBar(t) {
    const state = tabState(focused()?.tab);
    if (!state) return div();
    const live = liveStatus(state.tabId);
    const status = live?.status ?? (state.sftpPane ? 'connecting' : 'closed');
    const attention = status === 'prompt' || status === 'conflict';
    const vertical = Boolean(placement()?.vertical);
    const name = state.alias || 'SFTP';
    const tip = {
      connected: `${name} · SFTP connected`, connecting: `${name} · SFTP connecting…`,
      transferring: `${name} · transferring${live?.pct != null ? ` ${live.pct}%` : '…'}`,
      prompt: `${name} · waiting for a password or fingerprint`, conflict: `${name} · a file already exists: choose what to do`,
      error: `${name} · SFTP not connected`, closed: `${name} · SFTP closed`,
    }[status] ?? `${name} · SFTP`;
    const indicator = status === 'connecting'
      ? div().text_size(11).text_color(t.accent).child(SPINNER[0]).frames(SPINNER, 90)
      : status === 'transferring' && live?.pct != null
        ? div().text_size(10.5).text_color(t.accent).child(`${live.dir === 'down' ? '↓' : '↑'} ${live.pct}%`)
        : div().w(7).h(7).flex_none().rounded_full().bg(
          status === 'connected' || status === 'transferring' ? t.done : attention ? t.blocked : status === 'error' ? t.ansi1 : t.dim);
    const seg = (id, label, iconName, segTip) => {
      const on = state.mode === id;
      return h_flex().id(`ssh-bar-${id}`).h(22).px(vertical ? 5 : 7).gap(4).items_center().justify_center().rounded(5).flex_none()
        .bg(on ? t.selected : '#00000000').text_color(on ? t.foreground : t.muted)
        .hover(s => s.bg(on ? t.selected : t.hover).text_color(t.foreground))
        .tooltip(segTip).accessibility_label(segTip)
        .on_mouse_down('left', (_e, cx) => cx.stop_propagation())
        .on_click((_e, cx) => { cx.stop_propagation(); setMode(id, tabState(state.tabId), cx); })
        .child(icon(iconName, 12))
        .when(!vertical, el => el.child(label));
    };
    const buttons = [
      seg('ssh', 'SSH', 'terminal', 'SSH only (SFTP keeps running)'),
      seg('split', 'Split', 'split', 'SSH on top, SFTP below'),
      seg('sftp', 'SFTP', 'sftp', 'SFTP only (SSH keeps running)'),
    ];
    const status_ = h_flex().h(18).px(3).items_center().justify_center().tooltip(tip).accessibility_label(tip).child(indicator);
    if (vertical) {
      return v_flex().id('ssh-floating-bar').px(3).py(2).gap(3).items_center().text_size(11)
        .child(status_).child(div().w(16).h(1).bg(t.border)).children(buttons);
    }
    return h_flex().id('ssh-floating-bar').h(26).px(4).gap(4).items_center().text_size(11)
      .child(status_).child(div().w(1).h(12).bg(t.border)).children(buttons);
  }

  // The panel takes the keyboard when it appears, or when asked again.
  focusPanel() {
    const shown = panelShown(), asked = shared('ssh-hosts.focusPanel') ?? 0;
    if (shown && (!this.wasShown || asked !== this.asked)) this.search.focus();
    this.wasShown = shown;
    this.asked = asked;
  }

  render(cx) {
    if (this.sftp) return this.sftp.render(cx);
    if (this.redirected) return div();
    const t = theme();
    if (this.auth) return this.renderAuth(t);
    if (this.bar) return this.renderBar(t);
    if (!this.popup) {
      // A collapsed sidebar is narrow: show only the icon, centered, with a tooltip.
      const compact = this.rowWidth != null && this.rowWidth < COMPACT;
      return h_flex().id('ssh-open').size_full().gap(8).items_center().overflow_hidden()
        .when(compact, el => el.justify_center().tooltip('SSH hosts (Ctrl+Shift+H)')).when(!compact, el => el.px(16))
        .bg(t.chrome).text_size(12).text_color(t.muted).role('button').accessibility_label('SSH')
        .hover(s => s.bg(t.hover).text_color(t.foreground))
        .on_size_change((size, cx) => {
          const was = this.rowWidth != null && this.rowWidth < COMPACT;
          this.rowWidth = size.width;
          if (was !== size.width < COMPACT) cx.notify();
        })
        .on_click(() => SSHHosts.openPicker())
        .child(icon('terminal'))
        .when(!compact, el => el.child('SSH')
          .child(div().flex_1().text_size(10).text_color(t.dim).child(String(this.hosts.length)))
          .child(icon('chevron-right')));
    }
    const list = this.list(t);
    if (this.cursor >= this.rows.length) this.cursor = Math.max(0, this.rows.length - 1);
    if (this.panel) this.focusPanel();
    // In a panel, like Files: a card filling the block, with a titled header.
    const frame = this.panel
      ? v_flex().id('ssh-panel').size_full().min_h(0).rounded(10).overflow_hidden().bg(t.background)
        .border_1().border_color(t.border).text_color(t.foreground).text_size(12)
        .child(h_flex().h(42).flex_none().px(14).gap(8).items_center().border_b(1).border_color(t.border)
          .child(div().font_semibold().text_size(13).child('SSH'))
          .child(div().flex_1().min_w(0).truncate().text_right().text_color(t.dim)
            .child(this.loading ? '' : `${this.hosts.length} host${this.hosts.length === 1 ? '' : 's'}`)))
      : v_flex().id('ssh-popup').w(WIDTH).h(props()?.height ?? 420).min_h(0).bg(t.chrome).text_size(12);
    const close = () => this.panel ? hidePanel() : this.done();
    return frame
      .on_key_down((e, cx) => {
        if (e.key === 'escape' && this.panel) { hidePanel(); cx.stop_propagation(); return; }
        const moves = { up: -1, down: 1 };
        if (!(e.key in moves) || !this.rows.length) return;
        this.cursor = (this.cursor + moves[e.key] + this.rows.length) % this.rows.length;
        cx.stop_propagation();
        cx.notify();
      })
      .child(h_flex().h(52).flex_none().px(10).gap(6).items_center()
        .child(Input.new(this.search).h(32).px(10).flex_1().min_w(0).rounded(6).border_1().border_color(t.input)
          .bg(t.background).text_color(t.foreground).text_size(12).accessibility_label('Search host'))
        .child(h_flex().id('ssh-close').w(32).h(32).flex_none().items_center().justify_center().rounded(6).text_color(t.muted)
          .tooltip(this.panel ? 'Close the panel (Esc)' : 'Close (Esc)').accessibility_label('Close')
          .hover(s => s.bg(t.hover).text_color(t.foreground)).on_click(close).child(icon('close'))))
      .child(list)
      .child(h_flex().h(36).flex_none().px(14).gap(8).items_center().border_t_1().border_color(t.border).text_size(11).text_color(t.dim)
        .child(div().flex_1().truncate().child('Enter open · Ctrl+Enter another session'))
        .child(h_flex().id('ssh-edit').px(6).h(24).items_center().rounded(5).text_color(t.muted)
          .hover(s => s.bg(t.hover).text_color(t.foreground)).tooltip(this.path)
          .on_click(() => this.editConfig()).child('Edit config')));
  }
}
