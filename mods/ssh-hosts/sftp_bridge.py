"""SFTP v3 over the installed OpenSSH. Standard library only: no packages,
no stored passwords, no startup service.

`start` launches one worker per open SFTP view and prints its loopback URL
and a random token. The view talks to it with HTTP (`fetch`): `/rpc` runs an
action, `/events` long-polls until the state changes, and `/askpass` is how
OpenSSH asks the view for a password or a host-key decision (askpass.py).
Only the worker owns the SSH pipes. UI calls never block on transfers.
"""
import collections
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import posixpath
import re
import secrets
import stat
import shutil
import struct
import subprocess
import tempfile
import sys
import threading
import time
from urllib.parse import parse_qs, urlparse

BASE = Path(__file__).resolve().parent
NO_WINDOW = getattr(subprocess, 'CREATE_NO_WINDOW', 0)
CHUNK = 32768        # bytes per SFTP read/write request (OpenSSH's own size)
WINDOW = 64          # requests in flight per transfer: ~2 MB, like OpenSSH sftp
MAX_ENTRIES = 20000  # per listing
IDLE = 90            # seconds without the view before the worker exits

# SFTP v3 packet types
INIT, VERSION, OPEN, CLOSE, READ, WRITE, LSTAT = 1, 2, 3, 4, 5, 6, 7
OPENDIR, READDIR, REMOVE, MKDIR, RMDIR, REALPATH, STAT, RENAME = 11, 12, 13, 14, 15, 16, 17, 18
EXTENDED = 200
STATUS, HANDLE, DATA, NAME, ATTRS = 101, 102, 103, 104, 105
EOF, NO_SUCH_FILE = 1, 2


def u32(n):
    return struct.pack('>I', n)


def u64(n):
    return struct.pack('>Q', n)


def string(value):
    value = value.encode('utf-8') if isinstance(value, str) else value
    return u32(len(value)) + value


class Reader:
    def __init__(self, data):
        self.data, self.offset = data, 0

    def take(self, count):
        end = self.offset + count
        if end > len(self.data):
            raise ValueError('Respuesta SFTP incompleta')
        result = self.data[self.offset:end]
        self.offset = end
        return result

    def int(self):
        return struct.unpack('>I', self.take(4))[0]

    def str(self):
        return self.take(self.int())

    def text(self):
        return self.str().decode('utf-8', 'strict')

    def attrs(self):
        flags, out = self.int(), {}
        if flags & 1:
            out['size'] = struct.unpack('>Q', self.take(8))[0]
        if flags & 2:
            self.take(8)
        if flags & 4:
            out['mode'] = self.int()
        if flags & 8:
            self.int()
            out['mtime'] = self.int()
        if flags & 0x80000000:
            for _ in range(self.int()):
                self.str(), self.str()
        return out


SFTP_STATUS = {2: 'Does not exist', 3: 'Permission denied', 4: 'The server could not complete the operation',
               5: 'Bad message', 6: 'No connection', 7: 'Connection lost',
               8: 'The server does not support this operation'}


class SftpError(Exception):
    """A status from the server, said in English; the server's own words
    follow when they add something (code 4, "failure", says nothing alone)."""

    def __init__(self, code, message, where=None):
        text = SFTP_STATUS.get(code)
        if not text:
            text = message or f'SFTP error {code}'
        elif code == 4 and message and message.lower() != 'failure':
            text += f' ({message})'
        if where:
            text += f': “{where}”'
        super().__init__(text)
        self.code, self.server = code, message


class Conflict(Exception):
    """The destination exists; the view asks before overwriting."""


class Pending:
    """One request in flight: the reader thread fills it in when its answer arrives."""
    __slots__ = ('event', 'kind', 'reader', 'error')

    def __init__(self):
        self.event = threading.Event()
        self.kind = self.reader = self.error = None

    def wait(self):
        self.event.wait()
        if self.error:
            raise self.error
        return self.kind, self.reader


class SFTP:
    """One SFTP session that many threads can use at once: browsing and
    transfers share the connection (and the password typed for it). Every
    request carries an id; a reader thread hands each answer to its request."""

    def __init__(self, argv, env=None):
        self.errors = collections.deque(maxlen=12)
        self.serial = 0
        self.extensions = {}
        self.pending = {}
        self.lock = threading.Lock()  # serial, pending and writes
        self.broken = None
        self.process = subprocess.Popen(argv, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                        stderr=subprocess.PIPE, env=env, creationflags=NO_WINDOW)
        threading.Thread(target=self.drain, daemon=True).start()

    def drain(self):
        for line in iter(self.process.stderr.readline, b''):
            self.errors.append(line.decode('utf-8', 'replace').strip())

    def initialize(self):
        self.write_packet(INIT, u32(3))
        kind, result = self.read_packet()
        if kind != VERSION or result.int() != 3:
            raise ValueError('The server does not support SFTP version 3')
        while result.offset < len(result.data):
            name = result.text()
            self.extensions[name] = result.str()
        threading.Thread(target=self.dispatch, daemon=True).start()

    def lost(self):
        return ConnectionError('\n'.join(self.errors) or 'The SFTP connection closed')

    def dispatch(self):
        try:
            while True:
                kind, result = self.read_packet()
                number = result.int()
                with self.lock:
                    pending = self.pending.pop(number, None)
                if pending is None:
                    raise ValueError('SFTP response out of sequence')
                pending.kind, pending.reader = kind, result
                pending.event.set()
        except Exception as error:
            failure = error if isinstance(error, ConnectionError) else ConnectionError(str(error))
            with self.lock:
                self.broken = failure
                waiting, self.pending = list(self.pending.values()), {}
            for pending in waiting:
                pending.error = failure
                pending.event.set()

    # --- framing ---------------------------------------------------------

    def write_packet(self, kind, body):
        self.process.stdin.write(u32(len(body) + 1) + bytes([kind]) + body)
        self.process.stdin.flush()

    def read(self, size):
        result = bytearray()
        while len(result) < size:
            data = self.process.stdout.read(size - len(result))
            if not data:
                raise self.lost()
            result.extend(data)
        return bytes(result)

    def read_packet(self):
        size = struct.unpack('>I', self.read(4))[0]
        if not 1 <= size <= 8 * 1024 * 1024:
            raise ValueError('Invalid SFTP packet')
        data = self.read(size)
        return data[0], Reader(data[1:])

    # --- requests --------------------------------------------------------

    def send(self, kind, body=b''):
        """Sends a request without waiting for it; `.wait()` on the result
        gives (kind, reader). Requests can be pipelined from any thread."""
        pending = Pending()
        with self.lock:
            if self.broken:
                raise self.broken
            self.serial = (self.serial + 1) & 0xFFFFFFFF
            self.pending[self.serial] = pending
            try:
                self.write_packet(kind, u32(self.serial) + body)
            except OSError:
                self.pending.pop(self.serial, None)
                raise self.lost()
        return pending

    @staticmethod
    def check(kind, result, expected):
        if kind == STATUS:
            code, message = result.int(), result.text()
            if code:
                raise SftpError(code, message or f'SFTP error {code}')
        if kind != expected:
            raise ValueError('Respuesta SFTP inesperada')
        return result

    def request(self, kind, body=b'', expected=STATUS):
        response, result = self.send(kind, body).wait()
        return self.check(response, result, expected)

    def realpath(self, path):
        result = self.request(REALPATH, string(path), NAME)
        if result.int() != 1:
            raise ValueError('Invalid SFTP path')
        return result.text()

    def lstat(self, path):
        return self.request(LSTAT, string(path), ATTRS).attrs()

    def stat(self, path):
        return self.request(STAT, string(path), ATTRS).attrs()

    def exists(self, path):
        try:
            return self.lstat(path)
        except SftpError as error:
            if error.code == NO_SUCH_FILE:
                return None
            raise

    def close_handle(self, handle):
        self.request(CLOSE, string(handle))

    def rename(self, source, target, overwrite=False):
        if overwrite and 'posix-rename@openssh.com' in self.extensions:
            self.request(EXTENDED, string('posix-rename@openssh.com') + string(source) + string(target))
            return
        if overwrite and self.exists(target) is not None:
            self.request(REMOVE, string(target))
        # SFTP v3 rename fails if the target exists: that is the no-overwrite guarantee.
        self.request(RENAME, string(source) + string(target))

    def listing(self, path):
        try:
            path = self.realpath(path)
            handle = self.request(OPENDIR, string(path), HANDLE).str()
        except SftpError as error:  # say which folder
            raise SftpError(error.code, error.server, where=path) from None
        entries, limited = [], False
        try:
            while not limited:
                try:
                    result = self.request(READDIR, string(handle), NAME)
                except SftpError as error:
                    if error.code == EOF:
                        break
                    raise
                for _ in range(result.int()):
                    name = result.text()
                    result.str()  # longname is presentation-only; never parse it.
                    attrs = result.attrs()
                    if name in ('.', '..') or '/' in name or '\x00' in name:
                        continue
                    mode = attrs.get('mode', 0)
                    entries.append(dict(name=name, dir=stat.S_ISDIR(mode), link=stat.S_ISLNK(mode),
                                        size=attrs.get('size'), mtime=attrs.get('mtime'),
                                        mode=stat.S_IMODE(mode) if mode else None))
                    if len(entries) >= MAX_ENTRIES:
                        limited = True
                        break
        finally:
            self.close_handle(handle)
        # Links that point at folders open like folders.
        for entry in entries:
            if entry['link']:
                try:
                    target = self.stat(posixpath.join(path, entry['name']))
                except (SftpError, ValueError):
                    continue  # a broken link stays a link
                entry['dir'] = stat.S_ISDIR(target.get('mode', 0))
                entry.update(size=target.get('size'), mtime=target.get('mtime'))
        entries.sort(key=lambda e: (not e['dir'], e['name'].casefold()))
        return dict(path=path, entries=entries, limited=limited)

    # --- transfers (pipelined: up to WINDOW requests in flight) -----------

    def upload(self, local, remote, progress, cancelled, overwrite=False):
        if not Path(local).is_file():
            raise ValueError('Choose a local file, not a folder')
        existing = self.exists(remote)
        if existing is not None:
            if not overwrite:
                raise Conflict(f'“{posixpath.basename(remote)}” already exists on the server')
            if stat.S_ISDIR(existing.get('mode', 0)):
                raise ValueError('The destination is a folder; it is not overwritten')
        # An overwritten file keeps its permissions; a new one gets rw-r--r--.
        mode = stat.S_IMODE(existing['mode']) if existing and existing.get('mode') else 0o644
        temporary = posixpath.join(posixpath.dirname(remote), '.herdr-upload-' + secrets.token_hex(10))
        # WRITE | CREAT | EXCL, with permissions
        handle = self.request(OPEN, string(temporary) + u32(2 | 8 | 32) + u32(4) + u32(mode), HANDLE).str()
        pending, failure, complete = collections.deque(), None, False
        try:
            with open(local, 'rb') as source:
                total = os.fstat(source.fileno()).st_size
                offset = done = 0
                finished = False
                while True:
                    while not finished and failure is None and len(pending) < WINDOW and not cancelled():
                        data = source.read(CHUNK)
                        if not data:
                            finished = True
                            break
                        pending.append((self.send(WRITE, string(handle) + u64(offset) + string(data)), len(data)))
                        offset += len(data)
                    if not pending:
                        break
                    request, size = pending.popleft()
                    kind, result = request.wait()
                    try:
                        self.check(kind, result, STATUS)
                    except SftpError as error:
                        failure = failure or error
                        continue
                    done += size
                    progress(done, total)
            if failure:
                raise failure
            if cancelled():
                raise InterruptedError('Transferencia cancelada')
            self.close_handle(handle)
            handle = None
            if not overwrite and self.exists(remote) is not None:
                raise Conflict(f'“{posixpath.basename(remote)}” already exists on the server')
            self.rename(temporary, remote, overwrite)
            complete = True
        finally:
            if handle is not None:
                try:
                    self.close_handle(handle)
                except Exception:
                    pass
            if not complete:
                try:
                    self.request(REMOVE, string(temporary))
                except Exception:
                    pass

    def download(self, remote, local, progress, cancelled, overwrite=False):
        attrs = self.stat(remote)  # follows links: a link to a file downloads the file
        if not stat.S_ISREG(attrs.get('mode', 0)):
            raise ValueError('Only files are downloaded, not folders')
        target = Path(local)
        if os.name == 'nt' and (any(c in target.name for c in '<>:"|?*') or target.name.endswith((' ', '.'))
                               or re.fullmatch(r'(?i)(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\..*)?', target.name)):
            raise ValueError('This name is not valid on Windows. Rename the file before downloading it.')
        if os.path.lexists(target):
            if not overwrite:
                raise Conflict(f'“{target.name}” already exists in the local folder')
            if target.is_dir():
                raise ValueError('The local destination is a folder; it is not overwritten')
        total = attrs.get('size', 0)
        temporary = target.parent / ('.herdr-download-' + secrets.token_hex(10))
        handle = self.request(OPEN, string(remote) + u32(1) + u32(0), HANDLE).str()
        pending, retry, failure = collections.deque(), collections.deque(), None
        next_offset, eof_at, done = 0, None, 0
        try:
            with open(temporary, 'xb') as output:
                while True:
                    while failure is None and len(pending) < WINDOW and not cancelled():
                        if retry:
                            offset, length = retry.popleft()
                            if eof_at is not None and offset >= eof_at:
                                continue
                        elif eof_at is None:
                            offset, length = next_offset, CHUNK
                            next_offset += CHUNK
                        else:
                            break
                        pending.append((self.send(READ, string(handle) + u64(offset) + u32(length)), offset, length))
                    if not pending:
                        break
                    request, offset, length = pending.popleft()
                    kind, result = request.wait()
                    if kind == STATUS:
                        code, message = result.int(), result.text()
                        if code == EOF:
                            eof_at = offset if eof_at is None else min(eof_at, offset)
                        else:
                            failure = failure or SftpError(code, message or f'SFTP error {code}')
                        continue
                    if kind != DATA:
                        failure = failure or ValueError('Respuesta SFTP inesperada')
                        continue
                    data = result.str()
                    if not data:
                        eof_at = offset if eof_at is None else min(eof_at, offset)
                        continue
                    output.seek(offset)
                    output.write(data)
                    done += len(data)
                    if len(data) < length:  # short read: ask for the rest
                        retry.append((offset + len(data), length - len(data)))
                    progress(done, max(total, done))
            if failure:
                raise failure
            if cancelled():
                raise InterruptedError('Transferencia cancelada')
            self.place(temporary, target, overwrite)
        finally:
            temporary.unlink(missing_ok=True)
            try:
                self.close_handle(handle)
            except Exception:
                pass

    @staticmethod
    def place(temporary, target, overwrite):
        if overwrite:
            os.replace(temporary, target)
            return
        try:
            # link() is atomic and refuses an existing destination on Windows and POSIX.
            os.link(temporary, target)
        except FileExistsError:
            raise Conflict(f'“{target.name}” already exists in the local folder')
        except OSError:
            # Filesystems without hard links (FAT, some network shares).
            if os.path.lexists(target):
                raise Conflict(f'“{target.name}” already exists in the local folder')
            os.rename(temporary, target)

    def close(self):
        if self.process.poll() is None:
            if os.name == 'nt':
                # Includes a pending askpass or ProxyJump child, if any.
                subprocess.run(['taskkill', '/PID', str(self.process.pid), '/T', '/F'],
                               stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                               creationflags=NO_WINDOW, timeout=5)
            else:
                self.process.terminate()
            try:
                self.process.wait(3)
            except subprocess.TimeoutExpired:
                self.process.kill()
                self.process.wait(3)
        for stream in (self.process.stdin, self.process.stdout, self.process.stderr):
            stream.close()


def askpass_program():
    if os.name == 'nt':
        return str(BASE / 'askpass.cmd')
    program = BASE / 'askpass.sh'
    # The bit can be lost when the mod is copied. Only touch it then: Herdr
    # reloads the mod on any change in its folder, even a chmod.
    if not os.access(program, os.X_OK):
        program.chmod(0o755)
    return str(program)


def ssh_command(alias, config, url=None, token=None):
    if not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9._-]*', alias):
        raise ValueError('Invalid SSH alias')
    env = os.environ.copy()
    if url:
        # Passwords, passphrases and host-key questions go to the view's dialog.
        env.update(SSH_ASKPASS=askpass_program(), SSH_ASKPASS_REQUIRE='force',
                   HERDR_SFTP_URL=url, HERDR_SFTP_TOKEN=token, HERDR_SFTP_PYTHON=sys.executable)
        if os.name == 'nt':
            env.setdefault('DISPLAY', ':0')
    # Never disable host-key verification or save a password. Config supplies jumps/keys.
    argv = ['ssh', '-F', config, '-T', '-o', 'StrictHostKeyChecking=ask',
            '-o', 'ConnectTimeout=20', '-o', 'ServerAliveInterval=15',
            '-o', 'ServerAliveCountMax=3', '-o', 'ForwardAgent=no',
            '-o', 'ClearAllForwardings=yes', '-o', 'PermitLocalCommand=no']
    if not url:
        argv += ['-o', 'BatchMode=yes']
    return argv + ['-s', alias, 'sftp'], env


SSH_ERRORS = (
    (r'Permission denied', 'The server rejected the password or the key.'),
    (r'Host key verification failed|REMOTE HOST IDENTIFICATION HAS CHANGED',
     'The server’s fingerprint was not accepted or has changed. Check known_hosts before connecting again.'),
    (r'Could not resolve hostname', 'The server was not found (unknown host name).'),
    (r'Connection refused', 'The server refused the connection (is SSH running on that port?).'),
    (r'timed out|No route to host|Network is unreachable', 'Could not reach the server (timed out or network unavailable).'),
    (r'subsystem request failed', 'The server does not have SFTP enabled.'),
)


def explain(text):
    """OpenSSH's last words, with a plain explanation in front."""
    for pattern, meaning in SSH_ERRORS:
        if re.search(pattern, text, re.I):
            return f'{meaning}\n{text}'
    return text


def safe_name(name):
    if not isinstance(name, str) or not name or name in ('.', '..') or any(c in name for c in '/\\\x00\r\n'):
        raise ValueError('Type a plain name, without slashes or line breaks')
    return name


# --- this computer's files (the local panel) -----------------------------

DRIVES = ''  # the local path that lists Windows drives


def local_path(folder, path):
    """An absolute local path; relative ones are relative to `folder`."""
    if path == DRIVES and os.name == 'nt':
        return DRIVES
    path = os.path.expanduser(path or '.')
    if os.name == 'nt' and re.fullmatch(r'[A-Za-z]:', path):
        path += '\\'
    if not os.path.isabs(path):
        if not folder:
            raise ValueError('Choose a drive first')
        path = os.path.join(folder, path)
    return os.path.abspath(path)


def local_listing(path):
    if path == DRIVES:
        drives = os.listdrives() if hasattr(os, 'listdrives') else [
            f'{c}:\\' for c in 'ABCDEFGHIJKLMNOPQRSTUVWXYZ' if os.path.exists(f'{c}:\\')]
        entries = [dict(name=d.rstrip('\\'), dir=True, link=False, size=None, mtime=None, mode=None, hidden=False)
                   for d in drives]
        return dict(path=DRIVES, entries=entries, limited=False)
    if not os.path.isdir(path):
        raise ValueError(f'The local folder “{path}” does not exist')
    entries, limited = [], False
    with os.scandir(path) as items:
        for item in items:
            try:
                info = item.stat(follow_symlinks=True)
            except OSError:
                info = item.stat(follow_symlinks=False)  # a broken link
            link = item.is_symlink()
            hidden = item.name.startswith('.') or bool(getattr(info, 'st_file_attributes', 0) & 2)
            folder = stat.S_ISDIR(info.st_mode)
            entries.append(dict(name=item.name, dir=folder, link=link, hidden=hidden,
                                size=None if folder else info.st_size, mtime=int(info.st_mtime),
                                mode=None if os.name == 'nt' else stat.S_IMODE(info.st_mode)))
            if len(entries) >= MAX_ENTRIES:
                limited = True
                break
    entries.sort(key=lambda e: (not e['dir'], e['name'].casefold()))
    return dict(path=path, entries=entries, limited=limited)


def local_parent(path):
    """The folder above `path`; above a Windows drive, the list of drives."""
    if path == DRIVES:
        return DRIVES
    parent = os.path.dirname(path.rstrip('\\/')) if os.name == 'nt' else os.path.dirname(path)
    if os.name == 'nt' and (not parent or parent == path.rstrip('\\/') or re.fullmatch(r'[A-Za-z]:', path.rstrip('\\/'))):
        return DRIVES
    return parent or path


def delete_all(args, remove):
    """Deletes `names` (or one `name`), each with `remove(name)`. The view
    must repeat the exact list in `confirm`. Returns (message, problems)."""
    names = args.get('names') if args.get('names') is not None else [args.get('name')]
    names = [safe_name(n) for n in names]
    if not names:
        raise ValueError('Nothing to delete')
    if args.get('confirm') != (names if args.get('names') is not None else names[0]):
        raise ValueError('Deletion not confirmed')
    done, problems = [], []
    for name in names:
        try:
            remove(name)
            done.append(name)
        except FolderNotEmpty:
            problems.append(f'“{name}”: the folder is not empty')
        except (SftpError, OSError, ValueError) as error:
            problems.append(f'“{name}”: {getattr(error, "strerror", None) or error}')
    if not done:
        raise ValueError('Nothing was deleted. ' + '; '.join(problems) if len(names) > 1 else
                         'Only empty folders are deleted' if problems[0].endswith('is not empty') else problems[0])
    message = f'Deleted “{done[0]}”' if len(done) == 1 else f'Deleted {len(done)} items'
    return message, ('Not deleted: ' + '; '.join(problems)) if problems else None


class FolderNotEmpty(Exception):
    pass


class Worker:
    def __init__(self, alias, config):
        self.alias, self.config = alias, config
        self.url = self.token = None
        self.lock = threading.Lock()
        self.changed = threading.Condition(self.lock)
        self.stop = threading.Event()
        self.cancel = threading.Event()
        self.presence = threading.Lock()
        self.active = 0  # requests being served: a long poll counts as presence
        self.last_seen = time.monotonic()
        self.client = None
        self.answers = {}  # prompt id -> [Event, answer]
        self.jobs, self.batches, self.current, self.asking = [], {}, None, None
        self.listing = dict(path='.', entries=[], limited=False)
        self.local = dict(path=None, entries=[], limited=False)
        self.state = dict(ready=False, busy=False, transfer=None, error=None, conflict=None, prompt=None,
                          path='.', revision=0, listing=0, message='',
                          local_path=None, local_limited=False, local_listing=0, queue=0)

    def touch(self, delta):
        with self.presence:
            self.active += delta
            self.last_seen = time.monotonic()

    def idle(self):
        with self.presence:
            return self.active == 0 and time.monotonic() - self.last_seen > IDLE

    def update(self, **values):
        with self.lock:
            self.state.update(values)
            self.state['revision'] += 1
            self.changed.notify_all()

    def set_listing(self, listing):
        with self.lock:
            self.listing = listing
            self.state.update(path=listing['path'], limited=listing['limited'], count=len(listing['entries']))
            self.state['listing'] += 1
            self.state['revision'] += 1
            self.changed.notify_all()

    def set_local(self, listing):
        with self.lock:
            self.local = listing
            self.state.update(local_path=listing['path'], local_limited=listing['limited'])
            self.state['local_listing'] += 1
            self.state['revision'] += 1
            self.changed.notify_all()

    def snapshot(self, listing=None, local=None, queue=None):
        with self.lock:
            out = dict(self.state)
            out['totals'] = self.totals()
            if queue is not None and queue != out['queue']:
                out['jobs'] = self.queue_view()
            if listing is not None and listing != out['listing']:
                out['entries'] = self.listing['entries']
            if local is not None and local != out['local_listing']:
                out['local_entries'] = self.local['entries']
            return out

    def local_action(self, args):
        """This computer's files: quick, so done right in the request."""
        try:
            self.local_job(args)
        except PermissionError as error:
            raise ValueError(f'Permission denied for “{error.filename or args.get("name")}”')
        except FileExistsError:
            raise ValueError(f'“{args.get("name")}” already exists')
        except FileNotFoundError as error:
            raise ValueError(f'“{error.filename or args.get("name")}” does not exist')
        except OSError as error:
            raise ValueError(error.strerror or str(error))

    def local_job(self, args):
        action, folder = args['action'], self.snapshot()['local_path']
        if action == 'local_delete':
            if not folder:
                raise ValueError('Choose a local folder first')

            def remove(name):
                target = os.path.join(folder, name)
                if os.path.isdir(target) and not os.path.islink(target):
                    try:
                        os.rmdir(target)
                    except OSError:
                        if os.listdir(target):
                            raise FolderNotEmpty()
                        raise
                else:
                    os.remove(target)
            message, problems = delete_all(args, remove)
            self.set_local(local_listing(folder))
            self.update(message=message, error=problems)
            return
        if action == 'local_list':
            path = args.get('path')
            path = local_parent(folder) if path == '..' and folder is not None else local_path(folder, path)
            self.set_local(local_listing(path))
            return
        if not folder:
            raise ValueError('Choose a local folder first')
        name = safe_name(args.get('name'))
        target = os.path.join(folder, name)
        if action == 'local_mkdir':
            os.mkdir(target)
            message = f'Local folder “{name}” created'
        elif action == 'local_rename':
            new_name = safe_name(args.get('new_name'))
            destination = os.path.join(folder, new_name)
            if os.path.lexists(destination):
                raise ValueError(f'“{new_name}” already exists. Choose another name.')
            os.rename(target, destination)
            message = f'Renamed to “{new_name}”'
        else:
            raise ValueError('Unknown action')
        self.set_local(local_listing(folder))
        self.update(message=message, error=None)

    def refresh_local(self, folder):
        if self.snapshot()['local_path'] == folder:
            try:
                self.set_local(local_listing(folder))
            except Exception:
                pass

    def wait(self, since, timeout):
        with self.lock:
            self.changed.wait_for(lambda: self.state['revision'] > since or self.stop.is_set(), timeout)

    # --- askpass -----------------------------------------------------------

    def ask(self, text, kind):
        """Called from askpass.py's request: blocks until the view answers."""
        if self.stop.is_set():
            return None
        number = secrets.token_hex(8)
        slot = [threading.Event(), None]
        self.answers[number] = slot
        if kind == 'secret' and re.search(r'(?i)passphrase', text):
            kind = 'passphrase'
        self.update(prompt=dict(id=number, text=text.strip(), kind=kind))
        try:
            slot[0].wait(300)
            return slot[1]
        finally:
            self.answers.pop(number, None)
            with self.lock:
                if (self.state.get('prompt') or {}).get('id') == number:
                    self.state['prompt'] = None
                    self.state['revision'] += 1
                    self.changed.notify_all()

    def answer(self, number, value):
        slot = self.answers.get(number)
        if slot:
            slot[1] = value if isinstance(value, str) else None
            slot[0].set()

    def refuse_prompts(self):
        for slot in list(self.answers.values()):
            slot[0].set()

    # --- browsing ------------------------------------------------------------
    # Browsing (connect, list, mkdir, rename, delete) runs on its own thread;
    # the transfer queue on another, over the same connection, so transfers
    # never block moving around the server.

    def launch(self, args):
        action = args['action']
        with self.lock:
            if action != 'connect' and not self.state['ready']:
                raise ValueError('The session is not connected')
            if self.state['busy']:
                raise ValueError('An operation is in progress')
            self.state.update(busy=True, operation=action, error=None, message='')
            self.state['revision'] += 1
            self.changed.notify_all()
        threading.Thread(target=self.job, args=(args,), daemon=True).start()

    def failed(self, error):
        """Reports an error; returns its text. A lost connection says why."""
        text = str(error) or error.__class__.__name__
        client = self.client
        if client and (isinstance(error, ConnectionError) or client.broken or client.process.poll() is not None):
            # The connection is gone. ssh may still be exiting: give its last words a moment.
            try:
                client.process.wait(1)
            except subprocess.TimeoutExpired:
                pass
            text = explain('\n'.join(client.errors) or text)
            self.update(ready=False)
        self.update(error=text[:1800])
        return text[:1800]

    def refresh(self, folder):
        """Shows a change made in `folder` if that is still the folder shown."""
        if self.snapshot()['path'] != folder:
            return
        try:
            listing = self.client.listing(folder)
        except Exception:
            return
        if self.snapshot()['path'] == folder:
            self.set_listing(listing)

    # --- transfer queue --------------------------------------------------------
    # Files and folders wait in `self.jobs` and go one at a time. A folder job
    # creates its destination and puts its contents right behind it, so a big
    # tree is queued as it is walked. A file whose destination exists stops the
    # queue to ask (overwrite, skip or rename), unless its batch has an answer
    # for all.

    def touch_queue(self):
        """Call with self.lock held, after changing a job."""
        self.state['queue'] += 1
        self.state['revision'] += 1
        self.changed.notify_all()

    def new_job(self, kind, name, src, dst, folder, batch, size=None):
        return dict(id=secrets.token_hex(6), kind=kind, name=name, src=src, dst=dst, dir=bool(folder),
                    size=None if folder else size, status='queued', error=None, batch=batch)

    def enqueue(self, args):
        kind = args.get('kind')
        if kind not in ('upload', 'download'):
            raise ValueError('Transferencia desconocida')
        state = self.snapshot()
        if not state['ready']:
            raise ValueError('The session is not connected')
        remote_folder, local_folder = state['path'], state['local_path']
        batch, jobs = secrets.token_hex(4), []
        for path in args.get('paths') or []:  # dropped from the system: always uploads
            path = os.path.abspath(path)
            name = safe_name(os.path.basename(path.rstrip('\\/')))
            folder = os.path.isdir(path)
            jobs.append(self.new_job('upload', name, path, posixpath.join(remote_folder, name), folder, batch,
                                     None if folder else os.path.getsize(path)))
        for item in args.get('items') or []:
            name = safe_name(item.get('name'))
            if not local_folder:
                raise ValueError('Choose a local folder first')
            local, remote = os.path.join(local_folder, name), posixpath.join(remote_folder, name)
            src, dst = (local, remote) if kind == 'upload' else (remote, local)
            jobs.append(self.new_job(kind, name, src, dst, item.get('dir'), batch, item.get('size')))
        if not jobs:
            raise ValueError('No hay nada que transferir')
        with self.lock:
            self.batches[batch] = None
            self.jobs.extend(jobs)
            self.state.update(error=None, message='')
            self.touch_queue()

    def queue_action(self, args):
        action, number = args['action'], args.get('id')
        with self.lock:
            if action == 'resolve':
                pending = self.asking
                if pending and pending['job']['id'] == number:
                    choice = args.get('choice')
                    if choice not in ('overwrite', 'skip', 'rename'):
                        raise ValueError('Respuesta desconocida')
                    if args.get('all'):
                        self.batches[pending['job']['batch']] = choice
                    pending['choice'] = choice
                    pending['event'].set()
            elif action == 'cancel_job':
                for job in self.jobs:
                    if job['id'] == number:
                        self.cancel_job(job)
            elif action in ('cancel', 'cancel_all'):
                for job in self.jobs:
                    if action == 'cancel_all' or job is self.current:
                        self.cancel_job(job)
            elif action == 'retry':
                for job in self.jobs:
                    if job['status'] in ('failed', 'cancelled') and number in (None, job['id']):
                        job.update(status='queued', error=None)
            elif action == 'clear':
                self.jobs = [j for j in self.jobs if j['status'] in ('queued', 'running', 'conflict')]
            self.touch_queue()

    def cancel_job(self, job):
        """Call with self.lock held."""
        if job['status'] == 'queued':
            job['status'] = 'cancelled'
        elif job is self.current:
            self.cancel.set()
            if self.asking and self.asking['job'] is job:
                self.asking['event'].set()

    def next_job(self):
        with self.lock:
            while not self.stop.is_set():
                if self.state['ready']:
                    for job in self.jobs:
                        if job['status'] == 'queued':
                            job['status'] = 'running'
                            self.current = job
                            self.cancel.clear()
                            self.state['transfer'] = dict(id=job['id'], operation=job['kind'], name=job['name'],
                                                          done=0, total=job['size'] or 0, rate=0)
                            self.touch_queue()
                            return job
                self.changed.wait(1)
        return None

    def run_queue(self):
        refreshed = time.monotonic()
        while not self.stop.is_set():
            job = self.next_job()
            if job is None:
                return
            status, error = 'done', None
            try:
                if job['dir']:
                    self.expand(job)
                else:
                    status = self.transfer_file(job)
            except InterruptedError:
                status = 'cancelled'
            except Exception as failure:
                # A file's own problem stays on its row; a lost connection is everyone's.
                client = self.client
                lost = isinstance(failure, ConnectionError) or (client and (client.broken or client.process.poll() is not None))
                status, error = 'failed', self.failed(failure) if lost else (str(failure) or failure.__class__.__name__)
            with self.lock:
                job.update(status=status, error=error)
                self.current = None
                self.state['transfer'] = None
                left = any(j['status'] == 'queued' for j in self.jobs)
                if not left:
                    done = sum(j['status'] == 'done' and not j['dir'] for j in self.jobs)
                    self.state['message'] = f'Transferencias terminadas: {done} archivo{"s" * (done != 1)}'
                self.touch_queue()
            # Show the results, now and then during a long batch, and at its end.
            if not left or time.monotonic() - refreshed > 2:
                refreshed = time.monotonic()
                self.refresh(self.snapshot()['path'])
                self.refresh_local(self.snapshot()['local_path'])

    def progress(self):
        started, last = time.monotonic(), [0.0]

        def report(done, total):
            now = time.monotonic()
            if now - last[0] >= 0.1 or done >= total:
                last[0] = now
                with self.lock:
                    if self.state['transfer']:
                        self.state['transfer'] = dict(self.state['transfer'], done=done, total=total,
                                                      rate=int(done / max(now - started, 0.001)))
                        self.state['revision'] += 1
                        self.changed.notify_all()
        return report

    def describe(self, path, remote):
        """Size and date of one side of a conflict, for the question."""
        try:
            if remote:
                attrs = self.client.stat(path)
                return dict(size=attrs.get('size'), mtime=attrs.get('mtime'))
            info = os.stat(path)
            return dict(size=info.st_size, mtime=int(info.st_mtime))
        except Exception:
            return {}

    def decide(self, job):
        """What to do with an existing destination: the batch's answer, or ask."""
        choice = self.batches.get(job['batch'])
        if choice:
            return choice
        upload = job['kind'] == 'upload'
        pending = dict(job=job, event=threading.Event(), choice=None)
        source, target = self.describe(job['src'], not upload), self.describe(job['dst'], upload)
        with self.lock:
            more = any(j['status'] == 'queued' and j['batch'] == job['batch'] for j in self.jobs)
            job['status'] = 'conflict'
            self.asking = pending
            self.state['conflict'] = dict(id=job['id'], name=job['name'], kind=job['kind'], more=more,
                                          where='the server' if upload else 'this computer', source=source, target=target)
            self.touch_queue()
        try:
            while not pending['event'].wait(0.5):
                if self.stop.is_set():
                    break
            if not pending['choice']:
                raise InterruptedError('Transferencia cancelada')
            return pending['choice']
        finally:
            with self.lock:
                self.asking = None
                self.state['conflict'] = None
                if job['status'] == 'conflict':
                    job['status'] = 'running'
                self.touch_queue()

    def free_name(self, job):
        """“name (2).ext”: the first name not taken in the destination folder."""
        upload = job['kind'] == 'upload'
        folder, name = (posixpath.split if upload else os.path.split)(job['dst'])
        stem, dot, extension = name.rpartition('.')
        if not stem:
            stem, dot, extension = name, '', ''
        for n in range(2, 1000):
            candidate = f'{stem} ({n}){dot}{extension}'
            path = (posixpath.join if upload else os.path.join)(folder, candidate)
            if not (self.client.exists(path) is not None if upload else os.path.lexists(path)):
                return path
        raise ValueError('Could not find a free name')

    def transfer_file(self, job):
        client, upload = self.client, job['kind'] == 'upload'
        destination, overwrite = job['dst'], False
        exists = client.exists(destination) is not None if upload else os.path.lexists(destination)
        if exists:
            choice = self.decide(job)
            if choice == 'skip':
                return 'skipped'
            if choice == 'rename':
                destination = self.free_name(job)
                with self.lock:
                    job['dst'] = destination
                    job['renamed'] = (posixpath if upload else os.path).basename(destination)
            overwrite = choice == 'overwrite'
        if upload:
            client.upload(job['src'], destination, self.progress(), self.cancel.is_set, overwrite)
        else:
            client.download(job['src'], destination, self.progress(), self.cancel.is_set, overwrite)
        return 'done'

    def expand(self, job):
        """A folder: make it on the other side and queue what it holds behind it."""
        client, upload, children = self.client, job['kind'] == 'upload', []
        if upload:
            existing = client.exists(job['dst'])
            if existing is None:
                client.request(MKDIR, string(job['dst']) + u32(0))
            elif not stat.S_ISDIR(existing.get('mode', 0)):
                raise ValueError('A file with that name already exists on the server')
            with os.scandir(job['src']) as items:
                for item in sorted(items, key=lambda i: (not i.is_dir(), i.name.casefold())):
                    link_dir = item.is_symlink() and item.is_dir()
                    folder = item.is_dir(follow_symlinks=False)
                    try:
                        size = None if folder or link_dir else item.stat().st_size
                    except OSError:
                        size = None  # a broken link: its own job reports it
                    children.append((item.name, item.path, posixpath.join(job['dst'], item.name), folder, link_dir, size))
        else:
            if os.path.lexists(job['dst']):
                if not os.path.isdir(job['dst']):
                    raise ValueError('A file with that name already exists on this computer')
            else:
                os.mkdir(job['dst'])
            for entry in client.listing(job['src'])['entries']:
                children.append((entry['name'], posixpath.join(job['src'], entry['name']),
                                 os.path.join(job['dst'], entry['name']), entry['dir'] and not entry['link'],
                                 entry['dir'] and entry['link'], entry.get('size')))
        jobs = []
        for name, src, dst, folder, link_dir, size in children:
            child = self.new_job(job['kind'], job['name'] + '/' + name, src, dst, folder, job['batch'], size)
            if link_dir:  # never followed: a link can point back up the tree
                child.update(status='skipped', error='Link to a folder: not followed')
            jobs.append(child)
        with self.lock:
            at = self.jobs.index(job) + 1 if job in self.jobs else len(self.jobs)
            self.jobs[at:at] = jobs
            self.touch_queue()
        if self.cancel.is_set():
            raise InterruptedError('Transferencia cancelada')

    def queue_view(self):
        """What the view shows of the queue (call with self.lock held): the
        current and next jobs, the problems and the last finished ones."""
        active = [j for j in self.jobs if j['status'] in ('running', 'conflict')]
        waiting = [j for j in self.jobs if j['status'] == 'queued']
        problems = [j for j in self.jobs if j['status'] in ('failed', 'cancelled')]
        finished = [j for j in self.jobs if j['status'] in ('done', 'skipped')]
        shown = active + waiting[:150] + problems[:150] + finished[-50:]
        keys = ('id', 'kind', 'name', 'dir', 'size', 'status', 'error', 'renamed')
        return [{k: j.get(k) for k in keys} for j in shown]

    def totals(self):
        """Call with self.lock held."""
        files = [j for j in self.jobs if not j['dir']]
        count = collections.Counter(j['status'] for j in files)
        moved = sum(j['size'] or 0 for j in files if j['status'] == 'done')
        current = self.state['transfer']
        if current:
            moved += current['done']
        return dict(files=len(files), done=count['done'], skipped=count['skipped'], failed=count['failed'],
                    cancelled=count['cancelled'], waiting=count['queued'] + count['running'] + count['conflict'],
                    bytes=sum(j['size'] or 0 for j in files if j['status'] not in ('cancelled', 'skipped')),
                    moved=moved, folders=sum(1 for j in self.jobs if j['dir'] and j['status'] == 'queued'))

    def job(self, args):
        try:
            action = args['action']
            if action == 'connect':
                argv, env = ssh_command(self.alias, self.config, self.url, self.token)
                client = SFTP(argv, env)
                self.client = client
                client.initialize()
                try:  # the last folder this view showed, if it still exists
                    listing = client.listing(args.get('path') or '.')
                except (SftpError, ValueError):
                    listing = client.listing('.')
                self.set_listing(listing)
                self.update(ready=True, message='Connected')
                return
            client = self.client
            folder = self.snapshot()['path']
            if action == 'list':
                # Relative paths (typed, or "..") are relative to the folder shown.
                self.set_listing(client.listing(posixpath.join(folder, args.get('path') or '.')))
                return
            if action == 'delete':
                def remove(name):
                    remote = posixpath.join(folder, name)
                    mode = client.lstat(remote).get('mode', 0)
                    try:
                        client.request(RMDIR if stat.S_ISDIR(mode) else REMOVE, string(remote))
                    except SftpError:
                        if stat.S_ISDIR(mode) and client.listing(remote)['entries']:
                            raise FolderNotEmpty()
                        raise
                message, problems = delete_all(args, remove)
                self.set_listing(client.listing(folder))
                self.update(message=message, error=problems)
                return
            name = safe_name(args.get('name'))
            remote = posixpath.join(folder, name)
            if action == 'mkdir':
                client.request(MKDIR, string(remote) + u32(0))
                message = f'Folder “{name}” created'
            elif action == 'rename':
                new_name = safe_name(args.get('new_name'))
                destination = posixpath.join(folder, new_name)
                if client.exists(destination) is not None:
                    raise ValueError(f'“{new_name}” already exists. Choose another name.')
                client.rename(remote, destination)
                message = f'Renamed to “{new_name}”'
            else:
                raise ValueError('Unknown action')
            self.set_listing(client.listing(folder))
            self.update(message=message)
        except Exception as error:
            self.failed(error)
        finally:
            self.update(busy=False)

    def view(self, args):
        """Reads a text file of the folder shown, for the viewer. Read-only: nothing is kept."""
        client = self.client
        if not client or not self.snapshot()['ready']:
            raise ValueError('The session is not connected')
        name = safe_name(args.get('name'))
        remote = posixpath.join(self.snapshot()['path'], name)
        attrs = client.stat(remote)
        if not stat.S_ISREG(attrs.get('mode', 0)):
            raise ValueError('Only files can be viewed')
        if attrs.get('size', 0) > VIEW_LIMIT:
            raise ValueError(f'“{name}” is larger than {VIEW_LIMIT // 1024} KB: download it to open it')
        folder = tempfile.mkdtemp(prefix='herdr-view-')
        try:
            target = os.path.join(folder, 'file')
            client.download(remote, target, lambda done, total: None, self.cancel.is_set)
            with open(target, 'rb') as handle:
                data = handle.read(VIEW_LIMIT + 1)
        finally:
            shutil.rmtree(folder, ignore_errors=True)
        if b'\0' in data:
            raise ValueError(f'“{name}” is binary: it cannot be shown as text')
        return dict(name=name, text=data.decode('utf-8', errors='replace'), size=len(data))

    def close(self):
        self.stop.set()
        self.cancel.set()
        self.refuse_prompts()
        with self.lock:
            self.changed.notify_all()
        if self.client:
            try:
                self.client.close()
            except Exception:
                pass


VIEW_LIMIT = 1024 * 1024  # the viewer reads files up to 1 MB
ACTIONS = ('status', 'list', 'mkdir', 'rename', 'delete')
QUEUE_ACTIONS = ('resolve', 'cancel', 'cancel_job', 'cancel_all', 'retry', 'clear')
LOCAL_ACTIONS = ('local_list', 'local_mkdir', 'local_rename', 'local_delete')


def handler_for(worker, token):
    expected = ('Bearer ' + token).encode()

    class Handler(BaseHTTPRequestHandler):
        protocol_version = 'HTTP/1.1'

        def log_message(self, *_args):
            pass

        def reply(self, status, data):
            body = json.dumps(data, ensure_ascii=True).encode()
            self.send_response(status)
            self.send_header('Content-Type', 'application/json')
            self.send_header('Content-Length', str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def allowed(self):
            return secrets.compare_digest(self.headers.get('Authorization', '').encode(), expected)

        def body(self):
            size = int(self.headers.get('Content-Length') or 0)
            if size > 1024 * 1024:
                raise ValueError('Request too large')
            return json.loads(self.rfile.read(size) or b'{}')

        def handle_one_request(self):
            worker.touch(1)
            try:
                super().handle_one_request()
            finally:
                worker.touch(-1)

        def do_GET(self):
            if not self.allowed():
                return self.reply(403, dict(ok=False, error='Access denied'))
            url = urlparse(self.path)
            if url.path != '/events':
                return self.reply(404, dict(ok=False, error='No existe'))
            query = parse_qs(url.query)
            since = int(query.get('since', ['0'])[0])
            listing = int(query.get('listing', ['-1'])[0])
            local = int(query.get('local', ['-1'])[0])
            queue = int(query.get('queue', ['-1'])[0])
            worker.wait(since, 20)
            self.reply(200, dict(ok=True, **worker.snapshot(listing, local, queue)))

        def do_POST(self):
            if not self.allowed():
                return self.reply(403, dict(ok=False, error='Access denied'))
            try:
                args = self.body()
                if self.path == '/askpass':
                    # Waiting for an answer is not the view being there: an
                    # abandoned worker must still time out and refuse it.
                    worker.touch(-1)
                    try:
                        answer = worker.ask(str(args.get('prompt', '')), str(args.get('kind') or 'secret'))
                    finally:
                        worker.touch(1)
                    return self.reply(200, dict(ok=answer is not None, answer=answer))
                if self.path != '/rpc':
                    return self.reply(404, dict(ok=False, error='No existe'))
                action = args.get('action')
                if action == 'close':
                    worker.close()
                elif action == 'view':
                    return self.reply(200, dict(ok=True, view=worker.view(args)))
                elif action == 'enqueue':
                    worker.enqueue(args)
                elif action in QUEUE_ACTIONS:
                    worker.queue_action(args)
                elif action == 'answer':
                    worker.answer(str(args.get('id')), args.get('value'))
                elif action in LOCAL_ACTIONS:
                    worker.local_action(args)
                elif action in ACTIONS:
                    if action != 'status':
                        worker.launch(args)
                else:
                    raise ValueError('Unknown action')
                self.reply(200, dict(ok=True, **worker.snapshot()))
            except Exception as error:
                self.reply(200, dict(ok=False, error=str(error)))
    return Handler


def serve(alias, config, path='.'):
    worker, token = Worker(alias, config), secrets.token_hex(32)
    server = ThreadingHTTPServer(('127.0.0.1', 0), handler_for(worker, token))
    server.daemon_threads = True
    url = f'http://127.0.0.1:{server.server_address[1]}'
    worker.url, worker.token = url, token
    # Hand the address to `start` once, then let go of its pipe.
    sys.stdout.write(json.dumps(dict(url=url, token=token)) + '\n')
    sys.stdout.flush()
    os.dup2(os.open(os.devnull, os.O_WRONLY), 1)
    threading.Thread(target=server.serve_forever, kwargs=dict(poll_interval=0.5), daemon=True).start()
    threading.Thread(target=worker.run_queue, daemon=True).start()
    worker.launch(dict(action='connect', path=path))
    try:
        while not worker.stop.is_set() and not worker.idle():
            worker.stop.wait(1)
    finally:
        worker.close()
        server.shutdown()


def start(alias, config, path='.'):
    ssh_command(alias, config)  # validate before spawning
    child = subprocess.Popen([sys.executable, str(Path(__file__).resolve()), 'serve', alias, config, path],
                             stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                             creationflags=NO_WINDOW, start_new_session=os.name != 'nt')
    line = child.stdout.readline()
    child.stdout.close()
    try:
        info = json.loads(line)
    except ValueError:
        raise RuntimeError('Could not start the SFTP session')
    return dict(ok=True, **info)


if __name__ == '__main__':
    try:
        command = sys.argv[1]
        if command == 'serve':
            serve(*sys.argv[2:5])
        elif command == 'start':
            print(json.dumps(start(*sys.argv[2:5]), ensure_ascii=True))
        else:
            raise ValueError('Invalid command')
    except Exception as error:
        print(json.dumps(dict(ok=False, error=str(error)), ensure_ascii=True))
        sys.exit(1)
