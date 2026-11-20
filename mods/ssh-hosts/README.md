# SSH hosts

## One tab per host

Choosing a host opens a single tab named after the alias in **split view**: the
**SSH terminal** on top, with the keyboard, and the two-pane **SFTP browser**
below (**This computer** on the left, the server on the right, each at half the
width). Choosing a host whose tab is open goes back to it; **Ctrl+Enter** (or
Ctrl+click) opens another tab for it, which reuses the sign-in.

Three views, one click each, from the **SSH | Split | SFTP** switch at the right
of the SFTP toolbar or from the floating pill:

- **SSH**: the terminal at full size; the SFTP pane keeps running (and transferring).
- **Split**: both, SSH on top (the default).
- **SFTP**: the browser at full size; the terminal keeps running.

Closing one of the two panes leaves the other alone. The switch brings the
missing one back, without signing in again while the connection lives.

The toolbar's switch is hidden with the SFTP pane in the **SSH** view. To come
back, use the floating pill, the **unzoom** button of the pane header (in
layouts that draw one, such as Herdr's `main` and `terminals`), or `pane.zoom`
(**Ctrl+Shift+Z** with Herdr's default keys).

The **floating pill** (`props: { bar: true }`, optional but recommended, see
the repository's README) only draws on host tabs. It shows the SFTP status (a
green dot when connected, a spinner while connecting, amber when a sign-in
dialog or a file conflict waits, red when it is not connected, `↑ 42%` while
transferring) and the same three views. Drag it anywhere; it settles on the nearest edge.

## Signing in once

When OpenSSH needs a password, a key passphrase or confirmation of a new
server's fingerprint, a **centered dialog** asks it once; the same answer
serves SSH and SFTP. Meanwhile the terminal shows *Connecting to …* and starts
by itself when the sign-in is done. **Enter** in the terminal skips the wait and
signs in there instead; if the dialog's sign-in fails, the terminal asks too.

The password is typed or pasted (for example from KeePassXC) into a masked
field, handed only to OpenSSH, and never written to a file or an argument.
OpenSSH's host key verification is never turned off; the dialog shows the
fingerprint so you can compare it. Esc or Cancel refuses.

- **Linux and macOS:** the first ssh of a host becomes an OpenSSH
  **ControlMaster** (socket in `$XDG_RUNTIME_DIR/herdr-ssh/`, else
  `/tmp/herdr-ssh-<uid>/`, private to you), which stays 2 minutes after its last
  session (`ControlPersist`). The terminal, the browser and other tabs of that
  host ride on it. Nothing is kept by the mod.
- **Windows:** its OpenSSH has no ControlMaster. The browser's helper keeps the
  password typed in the dialog **in memory**, only after it worked, and answers
  the terminal's ssh with it through askpass **once**; it is forgotten then, after
  2 minutes, or when the pane closes. So on Windows a second session of a host,
  or a terminal reopened later, asks again (in the same dialog). Windows runs
  askpass through `cmd.exe`, which cannot carry a server's text safely, so there
  keyboard-interactive sign-in is off: password, key and passphrase work; a
  server that only offers keyboard-interactive (some one-time-code setups) does not.

A prompt written by the server (keyboard-interactive, which OpenSSH prefixes
with `(user@host)`) is shown under the title "<alias> asks", never as a key
passphrase or a fingerprint question. Links inside an uploaded folder are not
followed (a link to `~/.ssh/id_ed25519` in a cloned project stays here), and a
download refuses a local destination folder that is a link. On Windows,
directory junctions count as links. A folder swapped for a link while the
queue runs is refused when its turn comes.

Names that come from the server are checked before anything is written on this
computer: a name with a slash or backslash, `..`, and on Windows a drive or
stream (`C:x`, `x:y`), a device name (`NUL`, `COM1`…), a trailing dot or space,
or `<>"|?*` is never downloaded (it shows as skipped, with the reason).

## SFTP browser

- **One toolbar**: the connection status and alias (click to disconnect or
  reconnect), a summary (the selection, the last message, or an error, whose
  full text is in its tooltip), the actions (↑ upload, ↓ download, ⟳ refresh,
  + new folder, ✎ rename, ✕ delete, each with its key in the tooltip), and the
  SSH | Split | SFTP switch.
- **One header row per pane**: its path as breadcrumbs (every folder is
  clickable; a click on the free space lets you type the path, relative ones
  such as `..` included), a name filter and `.*` to show or hide hidden files.
  No footers: counts are in the pane icon's tooltip.
- Sort from the right-click menu: name, size or modified, again to reverse
  (natural order: `file2` before `file10`). Lists are virtual: large folders
  (up to 20,000 entries) scroll smoothly.
- If the layout draws its pane header over the pane (`reveal: "hover"`), the
  toolbar starts below it, so the header never hides its buttons. A header mod
  that draws nothing over SFTP panes can give that room back by adding its name
  to `shared("ssh-hosts.clearHeaders")`.
- On Windows the local pane starts at **Computer**, with the drives (`C:`, `D:`…).
- A click selects and marks the active pane; **Ctrl+click** adds or removes and
  **Shift+click** selects a range. Double-click opens a folder or sends the file
  to the other pane. ↑ and ↓ send the selection of each side (files and
  folders). New folder, Rename and Delete act on the active pane; Delete
  accepts several items at once.
- **Right-click** opens a menu with what can be done with the selection or the
  folder: view a file on the server, transfer, rename, delete, new folder, copy
  paths, refresh, show or hide hidden files, and sort.
- Keyboard, with the list focused:

  | Key | Action |
  |-----|--------|
  | ↑ ↓, Page Up / Page Down, Home / End | Move the cursor (with Shift, select) |
  | Enter | Open the folder, or send the selection to the other pane |
  | Backspace | Parent folder (the cursor stays on the folder you came out of) |
  | Tab | Switch pane |
  | F3 | View the server file (read-only, up to 1 MB) |
  | F5 | Send the selection to the other pane |
  | F2 / F7 / Del | Rename / New folder / Delete |
  | Ctrl+A / Ctrl+C | Select all / Copy the paths |
  | Ctrl+F / Ctrl+R / Ctrl+H | Filter / Refresh / Show hidden |
  | Escape | Clear the filter, or the selection; in a dialog, cancel |

  In dialogs, Enter confirms and Escape cancels.
- Files and **whole folders** are transferred. You can also drag files and
  folders from the system onto the server pane.
- Everything goes through a **queue**, a strip at the bottom that only appears
  while there are transfers: the running file, how many wait, the progress,
  speed and time left. A click unfolds one row per file, each of which can be
  cancelled or retried; there are also **Cancel all**, **Retry** for what
  failed, and **Clear**. When everything finished well the strip goes away
  after 3 seconds; problems stay until cleared. You can keep browsing meanwhile.
- Folders are walked as they go, so queuing a huge folder is instant. Links to
  folders (Windows junctions included) are not followed (they could form
  loops); links to files are transferred as files.
- If a file already exists at the destination, the queue stops and asks, showing
  the size and date of both: **Skip**, **Rename** (saves as “name (2).ext”) or
  **Overwrite**, and optionally the same for the other files of that transfer.
  A file overwritten on the server keeps its permissions; a new one gets
  `rw-r--r--`. A folder that already exists is completed without asking.
- **Delete** asks for confirmation and, on both sides, only removes a file, a
  link or an empty folder. Rename never replaces an existing file.
- The last local and remote folder are remembered per host, and the sort order
  and hidden-files setting per pane.

### Viewing files

**View** (right-click, or **F3**) shows a text file from the server in a
read-only viewer, with syntax highlighting. The helper reads it into a
temporary folder, which is deleted right away; nothing is saved and nothing can
be edited. Files over 1 MB, binary files and folders are refused with a message.

### How it works

It uses only OpenSSH (`ssh`) and Python 3 with its standard library; it installs
no packages or services.

- The **terminal** runs `sftp_bridge.py shell <alias> <config>`: it waits while
  the SFTP pane signs in (it reads `<runtime>/<alias>.json`, which the helper
  rewrites every 2 seconds), then runs `ssh` with the same ControlMaster
  options. With no SFTP pane signing in, it starts ssh after 4 seconds.
- Each **SFTP pane** starts a helper (`sftp_bridge.py`) with an `ssh -s sftp`
  connection. The pane talks to it over HTTP on `127.0.0.1` with a random key
  (the same helper lists local folders, identically on Linux and Windows):
  actions go through `/rpc` and changes arrive instantly through `/events` (no
  polling). OpenSSH asks for passwords through `askpass.sh` (`askpass.cmd` on
  Windows), which asks the helper, which asks the pane, which opens the dialog.
- Transfers send up to 64 blocks of 32 KB at a time, like OpenSSH's `sftp`
  client, and share the connection with browsing: every request carries a
  number and a reader thread hands each response to whoever asked for it.

The helper exits on disconnect, when the pane is closed, or after 90 seconds
without it. Transfers use `.herdr-upload-*` and `.herdr-download-*`
temporaries: a cancellation cleans them up; a forced close or a lost connection
can leave an incomplete one behind.

## SSH picker

Opens with **Ctrl+Shift+H** (`mod.open:ssh-hosts`, see the repository's
README), from an optional **SSH** row in a sidebar, or from a button in a tab
bar of your own. If the layout holds it as a **side panel** (a block with
`"props": { "panel": true }`, next to Files and Changes), all of them open the
panel instead of the popup; it stays open while you open hosts, and Esc or ×
closes it:

- **Search** on top, with the cursor already in it: it filters by alias, host,
  user or group. ↑ ↓ choose; **Enter** opens the host's tab (or goes to it),
  **Ctrl+Enter** opens another one. Esc closes.
- Each host shows its alias and, below, `user@host:port` (port 22 is not shown),
  plus a **jump** tag if it uses `ProxyJump`. On hover, a ☆ pins it to the top.
- A dot next to the alias means a tab is already open for that host.
- Sections: **Pinned**, **Recent** (when there are more than 6 hosts) and then
  the groups of the file. Pinned hosts, recents and collapsed groups are
  remembered.
- **Groups:** a comment right above a `Host` line (no blank line in between)
  opens a group with that name, which continues until the next one. Other
  comments are just comments. Without groups the list has no headings. A group
  whose name contains “prod” is shown in red. Groups have a folder icon and a
  shaded header, and their hosts are indented.

  ```
  # SSH configuration file      ← not a group (a blank line follows)

  # Development
  Host dev-api
      HostName 192.0.2.10

  # Production
  Host prod-api
      HostName api.example.com
  ```
- **Edit config** opens `~/.ssh/config` in the system editor. The list updates
  by itself when you save the file.
- Only explicit aliases of `~/.ssh/config` are read (not patterns or `Include`
  files). OpenSSH resolves user, port and other options when connecting; what
  the list shows is informational.
- A host's tab opens in the active local space; if there is none, an **SSH**
  space is created.

Requirements: OpenSSH on the PATH and a local ~/.ssh/config. No configurations or credentials are included. Installation and how to add it to a layout: see the README at the repository root.
