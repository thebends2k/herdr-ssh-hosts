// Reads ~/.ssh/config: the explicit aliases (patterns are not launchable), what
// each one connects to, and the groups the file's comments draw.
//
// A comment right above a `Host` line (no blank line between them) starts a
// group named by it, which lasts until the next such comment. Other comments
// (a file header, notes inside a block) are only comments. OpenSSH still
// resolves the real connection options itself; these are for showing.

const ALIAS = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/;
const SHOWN = { hostname: 'host', user: 'user', port: 'port', proxyjump: 'jump' };

function value(text) {
  return text.replace(/\s+#.*$/, '').trim().replace(/^"(.*)"$/, '$1');
}

export function parseConfig(text) {
  const hosts = [], seen = new Set(), defaults = {};
  let group = null, heading = null, block = [], wildcard = false;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) { heading = null; continue; }
    if (line.startsWith('#')) { heading = line.replace(/^#+\s*/, '').trim() || null; continue; }
    const host = line.match(/^Host(?:\s+|\s*=\s*)(.+)$/i);
    if (host) {
      if (heading && heading.length <= 40) group = heading;
      heading = null;
      block = [];
      const tokens = (host[1].match(/"[^"]*"|\S+/g) ?? []).map(t => t.replace(/^"|"$/g, ''));
      wildcard = tokens.length === 1 && tokens[0] === '*';
      for (const alias of tokens) {
        if (!ALIAS.test(alias) || seen.has(alias.toLowerCase())) continue;
        seen.add(alias.toLowerCase());
        const entry = { alias, group, host: null, user: null, port: null, jump: null };
        hosts.push(entry);
        block.push(entry);
      }
      continue;
    }
    heading = null;
    if (/^Match(?:\s|=)/i.test(line)) { block = []; wildcard = false; continue; }
    const option = line.match(/^([A-Za-z]+)(?:\s+|\s*=\s*)(.+)$/);
    const key = option && SHOWN[option[1].toLowerCase()];
    if (!key) continue;
    // As in OpenSSH, the first value given for a host wins.
    if (wildcard) defaults[key] ??= value(option[2]);
    for (const entry of block) entry[key] ??= value(option[2]);
  }
  for (const entry of hosts) {
    for (const key of ['user', 'port', 'jump']) entry[key] ??= defaults[key] ?? null;
    if (entry.port === '22') entry.port = null;
  }
  return hosts;
}

// Hosts by group, in the file's order. Without any named group there is one
// unnamed group (shown without a heading); otherwise ungrouped hosts go last.
export function groupHosts(hosts) {
  const groups = new Map();
  for (const entry of hosts) {
    if (!groups.has(entry.group)) groups.set(entry.group, []);
    groups.get(entry.group).push(entry);
  }
  const named = [...groups].filter(([name]) => name !== null).map(([name, list]) => ({ name, hosts: list }));
  const loose = groups.get(null);
  if (!named.length) return loose ? [{ name: null, hosts: loose }] : [];
  return loose ? [...named, { name: 'Other', hosts: loose }] : named;
}

// `user@host:port`, for showing under the alias.
export function target(entry) {
  if (!entry.host && !entry.user && !entry.port) return '';
  return `${entry.user ? entry.user + '@' : ''}${entry.host ?? entry.alias}${entry.port ? ':' + entry.port : ''}`;
}

export function launchPlan(alias, configPath, localSpaces) {
  if (!ALIAS.test(alias)) throw new Error('Invalid SSH alias');
  const argv = ['ssh', '-F', configPath, alias];
  const space = localSpaces.find(s => s.active) ?? localSpaces.find(s => s.name === 'SSH') ?? localSpaces[0];
  return space
    ? { command: 'tab.new', args: { space: space.id, name: alias, argv } }
    : { command: 'space.new', args: { machine: '', name: 'SSH', tab: alias, argv } };
}
