import { View, div, svg } from 'gpui-kit';
import { v_flex, h_flex, Input, InputState } from 'gpui-base';
import { exec, home, readTextFile, spaces, run, theme, props, openOverlay, closeOverlay, shared, setShared, watchFolder, window } from 'herdr';
import { parseConfig, groupHosts, target, launchPlan } from './config.js';
import { SftpPanel } from './sftp.js';

// The SSH row in the sidebar, and the popup it opens: the aliases in
// ~/.ssh/config, searchable, with pinned and recent hosts first. Each host
// opens a terminal (ssh) or the SFTP explorer; a host with one already open
// goes back to it.

const icon = name => svg('mods/ssh-hosts/' + name + '.svg').w(16).h(16).flex_none();
// Kept in shared state: unlike localStorage it lasts across popups and restarts.
const recall = (key, fallback) => shared('ssh-hosts.' + key) ?? fallback;
const remember = (key, value) => setShared('ssh-hosts.' + key, value);
const ROW = 40, HEAD = 26, WIDTH = 360, COMPACT = 120;

export default class SSHHosts extends View {
  init(initial, cx) {
    if (props()?.mode === 'sftp') {
      this.sftp = new SftpPanel();
      this.sftp.init(cx);
      return;
    }
    this.popup = Boolean(props()?.popup);
    this.hosts = [];
    this.error = null;
    this.loading = true;
    this.folder = home().replace(/[\\/]+$/, '') + '/.ssh';
    this.path = this.folder + '/config';
    this.refresh(cx);
    // Reload when the file changes; a timer only if the folder cannot be watched.
    cx.spawn(async cx => {
      try { for (;;) { await watchFolder(this.folder); this.refresh(cx); } }
      catch { cx.timer.every(30000, cx => this.refresh(cx)); }
    });
    if (this.popup) {
      this.search = InputState.new({ placeholder: 'Search host…' });
      this.search.on('change', (_e, cx) => { this.query = this.search.value().trim().toLowerCase(); this.cursor = 0; cx.notify(); });
      // Enter: terminal · Shift+Enter: files · Ctrl+Enter: a new terminal even if one is open.
      this.search.on('submit', (e, cx) => {
        const entry = this.rows?.[this.cursor];
        if (!entry) return;
        if (e?.shift) this.openSftp(entry.alias);
        else this.openTerminal(entry.alias, Boolean(e?.secondary));
      });
      this.query = '';
      this.cursor = 0;
      this.search.focus();
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

  // The tab already showing this host, if any: a terminal is named after the
  // alias, the explorer "SFTP · alias".
  session(alias, sftp = false) {
    const name = sftp ? `SFTP · ${alias}` : alias;
    for (const space of spaces()) {
      const tab = space.tabs.find(t => t.named && t.name === name);
      if (tab) return { space, tab };
    }
    return null;
  }

  show(found) {
    run('space.select', { id: found.space.id });
    run('tab.select', { id: found.tab.id });
  }

  used(alias) {
    remember('recent', [alias, ...recall('recent', []).filter(a => a !== alias)].slice(0, 8));
  }

  done() { if (props()?.overlay) closeOverlay(props().overlay); }

  openTerminal(alias, fresh = false) {
    this.used(alias);
    this.done();
    const found = !fresh && this.session(alias);
    if (found) return this.show(found);
    const plan = launchPlan(alias, this.path, spaces().filter(s => !s.machine));
    run(plan.command, plan.args);
  }

  openSftp(alias) {
    this.used(alias);
    this.done();
    const found = this.session(alias, true);
    if (found) return this.show(found);
    const plan = launchPlan(alias, this.path, spaces().filter(s => !s.machine));
    const space = plan.args.space;
    run('tab.new', { ...(space ? { space } : {}), name: `SFTP · ${alias}`, mod: 'ssh-hosts', props: { mode: 'sftp', alias, target: target(this.hosts.find(h => h.alias === alias) ?? {}) } });
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

  async close() { if (this.sftp) await this.sftp.close(); else this.search?.release(); }

  // --- what the popup lists ---------------------------------------------------

  // Sections in order: pinned, recent, then the config's groups; or, while
  // searching, every match. Each host appears once.
  sections() {
    const byAlias = new Map(this.hosts.map(h => [h.alias, h]));
    if (this.query) {
      const q = this.query;
      const hits = this.hosts.filter(h => [h.alias, h.host, h.user].some(v => v && v.toLowerCase().includes(q)));
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
    // A lone unnamed group needs no heading, unless pinned or recent come first.
    return out;
  }

  // The popup's height for its content, between a floor and a ceiling.
  static height(hosts) {
    const groups = groupHosts(hosts);
    const pinned = recall('pinned', []).length;
    const heads = groups.filter(g => g.name).length + (pinned ? 1 : 0) + (hosts.length > 6 && recall('recent', []).length ? 1 : 0);
    const rows = hosts.length + Math.min(4, hosts.length > 6 ? recall('recent', []).length : 0);
    return Math.max(220, Math.min(560, 52 + 44 + heads * (HEAD + 8) + rows * ROW + 16));
  }

  // --- drawing ----------------------------------------------------------------

  button(t, id, label, fn, tip) {
    return h_flex().id(id).w(28).h(26).items_center().justify_center().rounded(5).flex_none()
      .border_1().border_color(t.border).text_color(t.foreground).tooltip(tip).accessibility_label(tip)
      .hover(s => s.bg(t.selected))
      .on_mouse_down('left', (_e, cx) => cx.stop_propagation())
      .on_click((_e, cx) => { cx.stop_propagation(); fn(cx); })
      .child(div().w(16).h(16).flex_none().text_color(t.foreground).child(icon(label)));
  }

  row(t, entry, index) {
    const alias = entry.alias, chosen = index === this.cursor;
    const term = this.session(alias), files = this.session(alias, true);
    const pinned = recall('pinned', []).includes(alias);
    const where = target(entry);
    return h_flex().id('ssh-' + alias).h(ROW).flex_none().px(10).gap(10).items_center().rounded(6)
      .bg(chosen ? t.selected : '#00000000').text_color(t.foreground)
      .on_hover((hovered, cx) => { if (hovered && this.cursor !== index) { this.cursor = index; cx.notify(); } })
      .on_click(() => this.openTerminal(alias))
      .child(div().text_color(t.dim).child(icon('server')))
      .child(v_flex().flex_1().min_w(0)
        .child(h_flex().gap(6).items_center().min_w(0)
          .child(div().truncate().child(alias))
          .when(Boolean(term || files), el => el.child(div().w(6).h(6).flex_none().rounded(3).bg(t.done)
            .tooltip(term && files ? 'Terminal and files open' : term ? 'Terminal open' : 'Files open'))))
        .when(Boolean(where || entry.jump), el => el.child(h_flex().gap(6).min_w(0).text_size(11).text_color(t.dim)
          .when(Boolean(where), el => el.child(div().truncate().child(where)))
          .when(Boolean(entry.jump), el => el.child(div().flex_none().px(4).rounded(3).border_1().border_color(t.border)
            .tooltip(`Jumps via ${entry.jump}`).child('jump'))))))
      .when(chosen, el => el
        .child(this.button(t, 'term-' + alias, 'terminal', () => this.openTerminal(alias),
          term ? 'Go to the open terminal (Enter) · Ctrl+Enter opens another' : 'Open an SSH terminal (Enter)'))
        .child(this.button(t, 'files-' + alias, 'sftp', () => this.openSftp(alias),
          files ? 'Go to the open file browser (Shift+Enter)' : 'Browse files over SFTP (Shift+Enter)'))
        .child(h_flex().id('pin-' + alias).w(26).h(26).flex_none().items_center().justify_center().rounded(5)
          .text_color(pinned ? t.accent : t.dim).hover(s => s.bg(t.hover).text_color(t.foreground))
          .tooltip(pinned ? 'Unpin' : 'Pin to top').accessibility_label(pinned ? 'Unpin' : 'Pin to top')
          .on_mouse_down('left', (_e, cx) => cx.stop_propagation())
          .on_click((_e, cx) => { cx.stop_propagation(); this.togglePin(alias, cx); })
          .child(pinned ? '★' : '☆')))
      .when(!chosen && pinned, el => el.child(div().text_color(t.dim).child('★')));
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

  render(cx) {
    if (this.sftp) return this.sftp.render(cx);
    const t = theme();
    if (!this.popup) {
      // A collapsed sidebar is narrow: show only the icon, centered, with a tooltip.
      const compact = this.rowWidth != null && this.rowWidth < COMPACT;
      return h_flex().id('ssh-open').size_full().gap(8).items_center().overflow_hidden()
        .when(compact, el => el.justify_center().tooltip('SSH hosts')).when(!compact, el => el.px(16))
        .bg(t.chrome).text_size(12).text_color(t.muted).role('button').accessibility_label('SSH')
        .hover(s => s.bg(t.hover).text_color(t.foreground))
        .on_size_change((size, cx) => {
          const was = this.rowWidth != null && this.rowWidth < COMPACT;
          this.rowWidth = size.width;
          if (was !== size.width < COMPACT) cx.notify();
        })
        .on_click(() => {
          // A popup takes its content's size: the list, which only fills space, needs a set height.
          const height = SSHHosts.height(this.hosts);
          openOverlay({ mod: 'ssh-hosts', props: { popup: true, height }, kind: 'popup', width: WIDTH, height });
        })
        .child(icon('terminal'))
        .when(!compact, el => el.child('SSH')
          .child(div().flex_1().text_size(10).text_color(t.dim).child(String(this.hosts.length)))
          .child(icon('chevron-right')));
    }
    const list = this.list(t);
    if (this.cursor >= this.rows.length) this.cursor = Math.max(0, this.rows.length - 1);
    return v_flex().id('ssh-popup').w(WIDTH).h(props()?.height ?? 400).min_h(0).bg(t.chrome).text_size(12)
      .on_key_down((e, cx) => {
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
          .tooltip('Close (Esc)').accessibility_label('Close')
          .hover(s => s.bg(t.hover).text_color(t.foreground)).on_click(() => this.done()).child(icon('close'))))
      .child(list)
      .child(h_flex().h(36).flex_none().px(14).gap(8).items_center().border_t_1().border_color(t.border).text_size(11).text_color(t.dim)
        .child(div().flex_1().truncate().child('↑↓ choose · Enter terminal · Shift+Enter files'))
        .child(h_flex().id('ssh-edit').px(6).h(24).items_center().rounded(5).text_color(t.muted)
          .hover(s => s.bg(t.hover).text_color(t.foreground)).tooltip(this.path)
          .on_click(() => this.editConfig()).child('Edit config')));
  }
}
