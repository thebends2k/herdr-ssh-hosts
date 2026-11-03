# SSH hosts

## SFTP browser

Each host has a button with a folder-and-arrow icon on the right. It opens an
**SFTP · alias** tab with two panes, like FileZilla: **This computer** on the
left and the server on the right. Clicking the alias still opens SSH.

- Each pane has its path as breadcrumbs (every folder is clickable; a click on
  the free space lets you type the path, relative ones such as `..` included), ↑, ⟳,
  a name filter and `.*` to show or hide hidden files. The Name, Size and
  Modified columns sort when clicked (natural order: `file2` before `file10`).
  Lists are virtual: large folders (up to 20,000 entries) scroll smoothly.
- On Windows the local pane starts at **Computer**, with the drives (`C:`, `D:`…).
- A click selects and marks the active pane; **Ctrl+click** adds or removes and
  **Shift+click** selects a range. Double-click opens a folder or sends the file
  to the other pane. **Upload →** and **← Download** send the selection of each
  side (files and folders). **New folder**, **Rename** and **Delete** act on the
  active pane; Delete accepts several items at once.
- **Right-click** opens a menu with what can be done with the selection or the
  folder: view a file on the server, transfer, rename, delete, new folder, copy
  paths, refresh, and show or hide hidden files.
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
- Everything goes through a **queue**: at the bottom you see the total (files,
  bytes, speed and time left) and, expanded, one row per file with its status.
  Each row can be cancelled or retried; there are also **Cancel all**, **Retry**
  for what failed, and **Clear** for what finished. You can keep browsing
  meanwhile.
- Folders are walked as they go, so queuing a huge folder is instant. Links to
  folders are not followed (they could form loops); links to files are
  transferred as files.
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

### Passwords and fingerprints

When OpenSSH needs a password, a key passphrase or confirmation of a new
server's fingerprint, the tab shows a dialog of its own (the same on Linux,
macOS and Windows). The password is typed or pasted (for example from
KeePassXC) into a masked field, handed only to OpenSSH, and never stored in any
file or argument. OpenSSH's host key verification is never turned off; the
dialog shows the fingerprint so you can compare it. Aliases, users, keys and
jump hosts are read from `~/.ssh/config`.

### How it works

It uses only OpenSSH (`ssh`) and Python 3 with its standard library; it installs
no packages or services. Each open tab starts a helper (`sftp_bridge.py`) with
an `ssh -s sftp` connection. The tab talks to it over HTTP on `127.0.0.1` with a
random key that is never written to disk (the same helper lists local folders,
identically on Linux and Windows): actions go through `/rpc` and changes arrive
instantly through `/events` (no polling). OpenSSH asks for passwords through
`askpass.sh` (`askpass.cmd` on Windows), which asks the tab. Transfers send up
to 64 blocks of 32 KB at a time, like OpenSSH's `sftp` client, and share the
connection with browsing: every request carries a number and a reader thread
hands each response to whoever asked for it.

The helper exits on **Disconnect**, when the tab is closed, or after 90 seconds
without the tab. Transfers use `.herdr-upload-*` and `.herdr-download-*`
temporaries: a cancellation cleans them up; a forced close or a lost connection
can leave an incomplete one behind.

## SSH picker

An **SSH** row in the sidebar of a layout of your own (for example under Spaces) with the
number of hosts. Clicking it opens a popup list, sized to its content:

- **Search** on top, with the cursor already in it: it filters by alias, host or
  user. ↑ ↓ choose; **Enter** opens a terminal, **Shift+Enter** the file
  browser, **Ctrl+Enter** a new terminal even if one is already open. Esc
  closes.
- Each host shows its alias and, below, `user@host:port` (port 22 is not shown),
  plus a **jump** tag if it uses `ProxyJump`. On hover, **Terminal** and **Files**
  icon buttons and a ☆ to pin it to the top appear.
- A dot next to the alias means a terminal or a file browser is already open for
  that host; choosing it goes to that tab instead of opening another.
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
      HostName 10.0.0.5

  # Production
  Host prod-api
      HostName api.example.com
  ```
- **Edit config** opens `~/.ssh/config` in the system editor. The list updates
  by itself when you save the file.
- Only explicit aliases of `~/.ssh/config` are read (not patterns or `Include`
  files). OpenSSH resolves user, port and other options when connecting; what
  the list shows is informational.
- Choosing an alias opens a tab with `ssh -F <local-config> <alias>` in a local
  space; if there is none, an **SSH** space is created. The password, if needed,
  is typed in the terminal; the picker never stores it.

Requirements: OpenSSH on the PATH and a local ~/.ssh/config. No configurations or credentials are included. The mod does not enumerate Include files. Installation and how to add it to a layout: see the README at the repository root.
