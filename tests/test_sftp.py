"""SFTP interoperability against a local sftp-server (OpenSSH's on Linux/macOS,
Git for Windows' on Windows), and the worker's HTTP API end to end.

No real SSH connection, credential or user repository is involved: the
worker tests use a closed loopback port, or (Linux/macOS) a fake `ssh` that
asks through SSH_ASKPASS and then serves SFTP from a temporary folder.

Run from the repository root: python tests/test_sftp.py -v
"""
import importlib.util
import json
import os
from pathlib import Path
import shutil
import socket
import sys
import tempfile
import threading
import time
import unittest
import urllib.error
import urllib.request

MODULE = Path(__file__).resolve().parents[1] / 'mods' / 'ssh-hosts' / 'sftp_bridge.py'
spec = importlib.util.spec_from_file_location('sftp_bridge', MODULE)
bridge = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bridge)

SERVERS = [Path('/usr/lib/openssh/sftp-server'), Path('/usr/libexec/openssh/sftp-server'),
           Path('/usr/lib/ssh/sftp-server'), Path('/usr/libexec/sftp-server'),
           Path('C:/Program Files/Git/usr/lib/ssh/sftp-server.exe')]
SERVER = next((s for s in SERVERS if s.is_file()), None)
OPENER = urllib.request.build_opener(urllib.request.ProxyHandler({}))


def nothing(*_args):
    return None


@unittest.skipUnless(SERVER, 'no local sftp-server found')
class SftpIntegration(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='herdr-sftp-test-')
        self.root = Path(self.temp.name)
        (self.root / 'remote').mkdir()
        env = os.environ.copy()
        if os.name == 'nt':
            env['PATH'] = 'C:/Program Files/Git/usr/bin;' + env['PATH']
        self.sftp = bridge.SFTP([str(SERVER), '-d', str(self.root / 'remote')], env)
        self.sftp.initialize()
        self.remote = self.sftp.realpath('.')

    def tearDown(self):
        self.sftp.close()
        self.temp.cleanup()

    def test_binary_unicode_listing_transfer_rename_and_remove(self):
        payload = bytes(range(256)) * 1025
        source = self.root / "local ' ñ.bin"
        source.write_bytes(payload)
        remote = self.remote + "/archivo ' ñ.bin"
        progress = []
        self.sftp.upload(str(source), remote, lambda n, total: progress.append((n, total)), lambda: False)
        self.assertEqual(progress[-1], (len(payload), len(payload)))
        listing = self.sftp.listing(self.remote)
        self.assertEqual(listing['entries'][0]['name'], "archivo ' ñ.bin")
        self.assertEqual(listing['entries'][0]['size'], len(payload))
        destination = self.root / 'download.bin'
        self.sftp.download(remote, str(destination), nothing, lambda: False)
        self.assertEqual(destination.read_bytes(), payload)
        renamed = self.remote + '/renamed.bin'
        self.sftp.rename(remote, renamed)
        self.sftp.request(bridge.REMOVE, bridge.string(renamed))
        self.assertEqual(self.sftp.listing(self.remote)['entries'], [])

    def test_large_pipelined_transfer(self):
        # Several windows of requests in flight, and a size that is not a multiple of a chunk.
        payload = os.urandom(bridge.CHUNK * bridge.WINDOW * 3 + 12345)
        source = self.root / 'large.bin'
        source.write_bytes(payload)
        self.sftp.upload(str(source), self.remote + '/large.bin', nothing, lambda: False)
        self.assertEqual((self.root / 'remote' / 'large.bin').read_bytes(), payload)
        destination = self.root / 'large-back.bin'
        self.sftp.download(self.remote + '/large.bin', str(destination), nothing, lambda: False)
        self.assertEqual(destination.read_bytes(), payload)

    def test_browsing_while_transferring(self):
        # One connection, two threads: listings and a mkdir answer while a
        # download is in flight, and neither corrupts the other.
        payload = os.urandom(bridge.CHUNK * bridge.WINDOW * 4)
        (self.root / 'remote' / 'big.bin').write_bytes(payload)
        for i in range(30):
            (self.root / 'remote' / f'f{i:02}').touch()
        destination = self.root / 'big-back.bin'
        started, failures = threading.Event(), []

        def slow(done, total):
            started.set()
            time.sleep(0.002)

        def download():
            try:
                self.sftp.download(self.remote + '/big.bin', str(destination), slow, lambda: False)
            except Exception as error:  # reported below
                failures.append(error)
        worker = threading.Thread(target=download)
        worker.start()
        self.assertTrue(started.wait(10))
        listings = 0
        while worker.is_alive() and listings < 50:
            self.assertEqual(len(self.sftp.listing(self.remote)['entries']), 31 + bool(listings))
            if not listings:
                self.sftp.request(bridge.MKDIR, bridge.string(self.remote + '/during') + bridge.u32(0))
            listings += 1
        worker.join(30)
        self.assertFalse(failures)
        self.assertGreater(listings, 1, 'the download ended before browsing could overlap it')
        self.assertEqual(destination.read_bytes(), payload)

    def test_view_reads_text_and_refuses_binary_and_large_files(self):
        (self.root / 'remote' / 'nota.txt').write_text('hola ñ\n', encoding='utf-8')
        (self.root / 'remote' / 'datos.bin').write_bytes(b'ab\0cd')
        (self.root / 'remote' / 'grande.log').write_bytes(b'x' * (bridge.VIEW_LIMIT + 1))
        (self.root / 'remote' / 'carpeta').mkdir()
        worker = bridge.Worker('prueba', None)
        worker.client = self.sftp
        worker.state.update(ready=True, path=self.remote)
        view = worker.view(dict(name='nota.txt'))
        self.assertEqual((view['text'], view['name']), ('hola ñ\n', 'nota.txt'))
        for name, message in (('datos.bin', 'binary'), ('grande.log', 'larger than'), ('carpeta', 'Only files'), ('../x', 'plain name')):
            with self.assertRaisesRegex(ValueError, message):
                worker.view(dict(name=name))
        self.assertFalse(list(Path(tempfile.gettempdir()).glob('herdr-view-*')))

    def test_lost_connection_fails_waiting_requests(self):
        self.sftp.process.kill()
        with self.assertRaises(ConnectionError):
            self.sftp.listing(self.remote)
        with self.assertRaises(ConnectionError):
            self.sftp.listing(self.remote)

    def test_conflicts_overwrite_and_cancel_cleanup(self):
        source = self.root / 'source.bin'
        source.write_bytes(b'first' * 20000)
        remote = self.remote + '/same.bin'
        self.sftp.upload(str(source), remote, nothing, lambda: False)
        os.chmod(self.root / 'remote' / 'same.bin', 0o640)
        source.write_bytes(b'second')
        with self.assertRaises(bridge.Conflict):
            self.sftp.upload(str(source), remote, nothing, lambda: False)
        self.sftp.upload(str(source), remote, nothing, lambda: False, overwrite=True)
        self.assertEqual((self.root / 'remote' / 'same.bin').read_bytes(), b'second')
        if os.name != 'nt':  # an overwritten file keeps its permissions
            self.assertEqual((self.root / 'remote' / 'same.bin').stat().st_mode & 0o777, 0o640)
        dest = self.root / 'existing.bin'
        dest.write_bytes(b'preserve')
        with self.assertRaises(bridge.Conflict):
            self.sftp.download(remote, str(dest), nothing, lambda: False)
        self.assertEqual(dest.read_bytes(), b'preserve')
        self.sftp.download(remote, str(dest), nothing, lambda: False, overwrite=True)
        self.assertEqual(dest.read_bytes(), b'second')
        with self.assertRaises(InterruptedError):
            self.sftp.upload(str(source), self.remote + '/cancelled.bin', nothing, lambda: True)
        with self.assertRaises(InterruptedError):
            self.sftp.download(remote, str(self.root / 'cancelled.bin'), nothing, lambda: True)
        self.assertFalse(list(self.root.glob('.herdr-download-*')))
        self.assertFalse((self.root / 'cancelled.bin').exists())
        self.assertEqual([e['name'] for e in self.sftp.listing(self.remote)['entries']], ['same.bin'])

    @unittest.skipIf(os.name == 'nt', 'symbolic links need privileges on Windows')
    def test_links_to_files_and_folders(self):
        (self.root / 'remote' / 'data.txt').write_bytes(b'hola')
        (self.root / 'remote' / 'folder').mkdir()
        os.symlink('data.txt', self.root / 'remote' / 'to-file')
        os.symlink('folder', self.root / 'remote' / 'to-folder')
        entries = {e['name']: e for e in self.sftp.listing(self.remote)['entries']}
        self.assertTrue(entries['to-file']['link'] and not entries['to-file']['dir'])
        self.assertEqual(entries['to-file']['size'], 4)  # the target's size, not the link's
        self.assertTrue(entries['to-folder']['link'] and entries['to-folder']['dir'])
        destination = self.root / 'via-link.txt'
        self.sftp.download(self.remote + '/to-file', str(destination), nothing, lambda: False)
        self.assertEqual(destination.read_bytes(), b'hola')

    def test_mkdir_nonempty_delete_and_exclusive_rename(self):
        directory = self.remote + '/folder'
        self.sftp.request(bridge.MKDIR, bridge.string(directory) + bridge.u32(0))
        self.assertTrue(self.sftp.listing(self.remote)['entries'][0]['dir'])
        source = self.root / 'empty'
        source.touch()
        self.sftp.upload(str(source), directory + '/one', nothing, lambda: False)
        self.sftp.upload(str(source), directory + '/two', nothing, lambda: False)
        with self.assertRaises(bridge.SftpError):
            self.sftp.request(bridge.RMDIR, bridge.string(directory))
        with self.assertRaises(bridge.SftpError):
            self.sftp.rename(directory + '/one', directory + '/two')
        for name in ('one', 'two'):
            self.sftp.request(bridge.REMOVE, bridge.string(directory + '/' + name))
        self.sftp.request(bridge.RMDIR, bridge.string(directory))

    def test_errors_in_spanish_with_the_folder(self):
        with self.assertRaisesRegex(bridge.SftpError, r'^Does not exist: “.*/no-existe”$'):
            self.sftp.listing(self.remote + '/no-existe')
        if os.name != 'nt' and os.geteuid() != 0:
            closed = self.root / 'remote' / 'cerrada'
            closed.mkdir()
            closed.chmod(0)
            try:
                with self.assertRaisesRegex(bridge.SftpError, '^Permission denied: “'):
                    self.sftp.listing(self.remote + '/cerrada')
            finally:
                closed.chmod(0o755)

    def test_input_validation(self):
        for name in ('..', '../a', 'a/b', 'a\\b', 'x\nbye', ''):
            with self.assertRaises(ValueError):
                bridge.safe_name(name)
        with self.assertRaises(ValueError):
            bridge.ssh_command('-oProxyCommand=bad', 'config')


class LocalFiles(unittest.TestCase):
    """The local panel: listing, hidden files, paths and the delete rule."""

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='herdr-sftp-local-')
        self.root = os.path.realpath(self.temp.name)

    def tearDown(self):
        self.temp.cleanup()

    def test_listing_paths_and_hidden(self):
        Path(self.root, 'b10.txt').write_text('x')
        Path(self.root, '.oculto').touch()
        Path(self.root, 'carpeta').mkdir()
        listing = bridge.local_listing(self.root)
        self.assertEqual([e['name'] for e in listing['entries']][0], 'carpeta')  # folders first
        hidden = {e['name']: e['hidden'] for e in listing['entries']}
        self.assertTrue(hidden['.oculto'])
        self.assertFalse(hidden['b10.txt'])
        self.assertEqual(bridge.local_path(self.root, 'carpeta'), os.path.join(self.root, 'carpeta'))
        self.assertEqual(bridge.local_parent(os.path.join(self.root, 'carpeta')), self.root)
        with self.assertRaises(ValueError):
            bridge.local_listing(os.path.join(self.root, 'no-existe'))

    def test_local_actions_through_the_worker(self):
        worker = bridge.Worker('x', 'config')
        worker.local_action(dict(action='local_list', path=self.root))
        worker.local_action(dict(action='local_mkdir', name='nueva'))
        worker.local_action(dict(action='local_rename', name='nueva', new_name='otra'))
        self.assertEqual([e['name'] for e in worker.snapshot(local=-1)['local_entries']], ['otra'])
        Path(self.root, 'otra', 'dentro').touch()
        with self.assertRaisesRegex(ValueError, 'empty folders'):
            worker.local_action(dict(action='local_delete', name='otra', confirm='otra'))
        Path(self.root, 'archivo').touch()
        with self.assertRaisesRegex(ValueError, 'already exists'):
            worker.local_action(dict(action='local_rename', name='archivo', new_name='otra'))
        with self.assertRaisesRegex(ValueError, 'not confirmed'):
            worker.local_action(dict(action='local_delete', name='archivo'))
        worker.local_action(dict(action='local_delete', name='archivo', confirm='archivo'))
        worker.local_action(dict(action='local_list', path='otra'))
        self.assertEqual(worker.snapshot()['local_path'], os.path.join(self.root, 'otra'))
        worker.local_action(dict(action='local_list', path='..'))
        self.assertEqual(worker.snapshot()['local_path'], self.root)
        for bad in ('..', 'a/b', ''):
            with self.assertRaises(ValueError):
                worker.local_action(dict(action='local_mkdir', name=bad))

    def test_delete_several(self):
        worker = bridge.Worker('x', 'config')
        for name in ('a.txt', 'b.txt'):
            Path(self.root, name).touch()
        Path(self.root, 'vacía').mkdir()
        Path(self.root, 'llena').mkdir()
        Path(self.root, 'llena', 'x').touch()
        worker.local_action(dict(action='local_list', path=self.root))
        names = ['a.txt', 'b.txt', 'vacía', 'llena']
        with self.assertRaisesRegex(ValueError, 'not confirmed'):
            worker.local_action(dict(action='local_delete', names=names, confirm=names[:2]))
        worker.local_action(dict(action='local_delete', names=names, confirm=names))
        state = worker.snapshot(local=-1)
        self.assertEqual([e['name'] for e in state['local_entries']], ['llena'])
        self.assertEqual(state['message'], 'Deleted 3 items')
        self.assertIn('“llena”: the folder is not empty', state['error'])
        with self.assertRaisesRegex(ValueError, 'Only empty folders are deleted'):
            worker.local_action(dict(action='local_delete', name='llena', confirm='llena'))


class Worker:
    """A worker started like the view does, and its HTTP API."""

    def __init__(self, alias, config, path='.'):
        info = bridge.start(alias, str(config), path)
        self.url, self.token = info['url'], info['token']
        self.revision, self.listing = 0, -1

    def request(self, path, body=None, token=None):
        headers = {'Authorization': 'Bearer ' + (token or self.token), 'Content-Type': 'application/json'}
        data = json.dumps(body).encode() if body is not None else None
        with OPENER.open(urllib.request.Request(self.url + path, data, headers), timeout=30) as response:
            return json.loads(response.read())

    def rpc(self, **args):
        return self.request('/rpc', args)

    def until(self, test, seconds=20):
        deadline = time.monotonic() + seconds
        while time.monotonic() < deadline:
            state = self.request(f'/events?since={self.revision}&listing={self.listing}')
            self.revision = state['revision']
            if 'entries' in state:
                self.listing, self.entries = state['listing'], state['entries']
            if test(state):
                return state
        raise AssertionError('timed out; last state: ' + json.dumps(state)[:400])

    def close(self):
        try:
            self.rpc(action='close')
        except OSError:
            pass


class WorkerLifecycle(unittest.TestCase):
    def test_local_refusal_authentication_and_shutdown(self):
        # The only SSH connection here is to a closed loopback port.
        with socket.socket() as endpoint:
            endpoint.bind(('127.0.0.1', 0))
            port = endpoint.getsockname()[1]
        with tempfile.TemporaryDirectory(prefix='herdr-sftp-config-') as folder:
            config = Path(folder) / 'config'
            config.write_text(f'Host local-test\n HostName 127.0.0.1\n Port {port}\n BatchMode yes\n', encoding='utf-8')
            worker = Worker('local-test', config)
            try:
                state = worker.until(lambda s: not s['busy'])
                self.assertFalse(state['ready'])
                self.assertIn('refused the connection', state['error'])
                with self.assertRaises(urllib.error.HTTPError) as refused:
                    worker.request('/rpc', dict(action='close'), token='wrong')
                self.assertEqual(refused.exception.code, 403)
                self.assertTrue(worker.rpc(action='status')['ok'])
            finally:
                worker.close()
            time.sleep(1.5)
            with self.assertRaises(OSError):
                worker.rpc(action='status')


@unittest.skipUnless(SERVER and os.name != 'nt', 'needs a POSIX shell and a local sftp-server')
class AskpassEndToEnd(unittest.TestCase):
    """A fake `ssh` asks for a host-key decision and a password through
    SSH_ASKPASS, exactly like OpenSSH, then serves SFTP from a folder."""

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='herdr-sftp-askpass-')
        root = Path(self.temp.name)
        (root / 'bin').mkdir()
        (root / 'remote').mkdir()
        (root / 'remote' / 'hola.txt').write_text('hola')
        ssh = root / 'bin' / 'ssh'
        ssh.write_text(f'''#!/bin/sh
a=$("$SSH_ASKPASS" "The authenticity of host 'test' can't be established.
Are you sure you want to continue connecting (yes/no/[fingerprint])?") || exit 255
[ "$a" = yes ] || {{ echo "Host key verification failed." >&2; exit 255; }}
p=$("$SSH_ASKPASS" "test@host's password: ") || exit 255
[ "$p" = secreto ] || {{ echo "Permission denied (password)." >&2; exit 255; }}
{SERVER} -d {root / 'remote'} | {sys.executable} -c "$THROTTLE"
''')
        ssh.chmod(0o755)
        self.path = os.environ['PATH']
        os.environ['PATH'] = f'{root / "bin"}{os.pathsep}{self.path}'
        # Server-to-client bytes at ~8 MB/s, so a transfer lasts long enough to overlap.
        os.environ['THROTTLE'] = ('import sys, time\n'
                                  'while b := sys.stdin.buffer.read1(65536):\n'
                                  '    sys.stdout.buffer.write(b); sys.stdout.buffer.flush(); time.sleep(len(b) / 8e6)')
        self.root = root

    def tearDown(self):
        os.environ['PATH'] = self.path
        os.environ.pop('THROTTLE', None)
        self.temp.cleanup()

    def answer(self, worker, kind, value):
        state = worker.until(lambda s: s.get('prompt'))
        self.assertEqual(state['prompt']['kind'], kind)
        worker.rpc(action='answer', id=state['prompt']['id'], value=value)

    def test_hostkey_password_and_listing(self):
        worker = Worker('test', '/dev/null')
        try:
            self.answer(worker, 'hostkey', 'yes')
            self.answer(worker, 'secret', 'secreto')
            state = worker.until(lambda s: s['ready'] and not s['busy'])
            self.assertEqual([e['name'] for e in worker.entries], ['hola.txt'])
            worker.rpc(action='mkdir', name='nueva')
            state = worker.until(lambda s: not s['busy'] and s['message'])
            self.assertEqual(sorted(e['name'] for e in worker.entries), ['hola.txt', 'nueva'])
            worker.rpc(action='list', path='nueva')
            state = worker.until(lambda s: not s['busy'] and s['path'].endswith('/nueva'))
            worker.rpc(action='list', path='..')
            state = worker.until(lambda s: not s['busy'] and s['path'].endswith('/remote'))
        finally:
            worker.close()

    def test_browse_during_download(self):
        (self.root / 'remote' / 'big.bin').write_bytes(os.urandom(16 * 1024 * 1024))
        (self.root / 'remote' / 'sub').mkdir()
        worker = Worker('test', '/dev/null')
        try:
            self.answer(worker, 'hostkey', 'yes')
            self.answer(worker, 'secret', 'secreto')
            worker.until(lambda s: s['ready'] and not s['busy'])
            local = Path(self.temp.name) / 'big.bin'
            worker.rpc(action='local_list', path=str(local.parent))
            self.assertTrue(worker.rpc(action='enqueue', kind='download', items=[dict(name='big.bin', size=16 << 20)])['ok'])
            worker.until(lambda s: s['transfer'] and s['transfer']['done'] > 0)
            self.assertTrue(worker.rpc(action='list', path='sub')['ok'])
            state = worker.until(lambda s: not s['busy'] and s['path'].endswith('/sub'))
            self.assertTrue(state['transfer'], 'the listing should arrive while the download runs')
            state = worker.until(lambda s: not s['transfer'] and s['totals']['done'] == 1, seconds=30)
            self.assertEqual(local.read_bytes(), (self.root / 'remote' / 'big.bin').read_bytes())
        finally:
            worker.close()

    def test_transfers_between_panel_folders(self):
        local = Path(self.temp.name) / 'local'
        local.mkdir()
        (local / 'subir.txt').write_text('arriba')
        worker = Worker('test', '/dev/null')
        try:
            self.answer(worker, 'hostkey', 'yes')
            self.answer(worker, 'secret', 'secreto')
            worker.until(lambda s: s['ready'] and not s['busy'])
            worker.rpc(action='local_list', path=str(local))
            worker.rpc(action='enqueue', kind='download', items=[dict(name='hola.txt')])
            worker.until(lambda s: s['totals']['done'] == 1 and not s['totals']['waiting'])
            self.assertEqual((local / 'hola.txt').read_text(), 'hola')
            worker.rpc(action='enqueue', kind='upload', items=[dict(name='subir.txt')])
            worker.until(lambda s: s['totals']['done'] == 2 and not s['totals']['waiting'])
            self.assertEqual((self.root / 'remote' / 'subir.txt').read_text(), 'arriba')
            worker.until(lambda s: 'subir.txt' in [e['name'] for e in worker.entries])
        finally:
            worker.close()

    def connected(self):
        worker = Worker('test', '/dev/null')
        self.answer(worker, 'hostkey', 'yes')
        self.answer(worker, 'secret', 'secreto')
        worker.until(lambda s: s['ready'] and not s['busy'])
        return worker

    def test_folder_trees_both_ways(self):
        local = Path(self.temp.name) / 'local'
        tree = local / 'árbol'
        (tree / 'a' / 'b').mkdir(parents=True)
        (tree / 'raíz.txt').write_text('1')
        (tree / 'a' / 'dos.bin').write_bytes(os.urandom(300000))
        (tree / 'a' / 'b' / 'tres.txt').write_text('3')
        (tree / 'a' / 'vacía').mkdir()
        os.symlink('a', tree / 'enlace-carpeta')   # skipped: never followed
        os.symlink('raíz.txt', tree / 'enlace.txt')  # a link to a file uploads the file
        worker = self.connected()
        try:
            worker.rpc(action='local_list', path=str(local))
            worker.rpc(action='enqueue', kind='upload', items=[dict(name='árbol', dir=True)])
            state = worker.until(lambda s: s['totals']['files'] and not s['totals']['waiting'] and not s['totals']['folders'])
            self.assertEqual(state['totals']['done'], 4)
            self.assertEqual(state['totals']['skipped'], 1)
            remote = self.root / 'remote' / 'árbol'
            self.assertEqual((remote / 'a' / 'dos.bin').read_bytes(), (tree / 'a' / 'dos.bin').read_bytes())
            self.assertEqual((remote / 'a' / 'b' / 'tres.txt').read_text(), '3')
            self.assertEqual((remote / 'enlace.txt').read_text(), '1')
            self.assertTrue((remote / 'a' / 'vacía').is_dir())
            self.assertFalse((remote / 'enlace-carpeta').exists())
            # And back down, into another local folder.
            back = Path(self.temp.name) / 'back'
            back.mkdir()
            worker.rpc(action='local_list', path=str(back))
            worker.rpc(action='enqueue', kind='download', items=[dict(name='árbol', dir=True)])
            worker.until(lambda s: s['totals']['done'] == 8 and not s['totals']['waiting'] and not s['totals']['folders'])
            self.assertEqual((back / 'árbol' / 'a' / 'dos.bin').read_bytes(), (tree / 'a' / 'dos.bin').read_bytes())
            self.assertTrue((back / 'árbol' / 'a' / 'vacía').is_dir())
        finally:
            worker.close()

    def test_conflict_choices(self):
        local = Path(self.temp.name) / 'local'
        local.mkdir()
        names = ['uno.txt', 'dos.txt', 'tres.txt']
        for name in names:
            (local / name).write_text('nuevo ' + name)
            (self.root / 'remote' / name).write_text('viejo')
        worker = self.connected()
        items = [dict(name=n) for n in names]
        try:
            worker.rpc(action='local_list', path=str(local))
            # Skip, for all: one question for the whole batch.
            worker.rpc(action='enqueue', kind='upload', items=items)
            state = worker.until(lambda s: s['conflict'])
            self.assertEqual(state['conflict']['name'], 'uno.txt')
            self.assertTrue(state['conflict']['more'])
            self.assertEqual(state['conflict']['target']['size'], 5)
            worker.rpc(action='resolve', id=state['conflict']['id'], choice='skip', all=True)
            state = worker.until(lambda s: not s['totals']['waiting'])
            self.assertEqual(state['totals']['skipped'], 3)
            self.assertEqual((self.root / 'remote' / 'uno.txt').read_text(), 'viejo')
            # Rename one, then overwrite one.
            worker.rpc(action='enqueue', kind='upload', items=items[:1])
            state = worker.until(lambda s: s['conflict'])
            self.assertFalse(state['conflict']['more'])
            worker.rpc(action='resolve', id=state['conflict']['id'], choice='rename')
            worker.until(lambda s: not s['totals']['waiting'])
            self.assertEqual((self.root / 'remote' / 'uno (2).txt').read_text(), 'nuevo uno.txt')
            worker.rpc(action='enqueue', kind='upload', items=items[1:2])
            state = worker.until(lambda s: s['conflict'])
            worker.rpc(action='resolve', id=state['conflict']['id'], choice='overwrite')
            worker.until(lambda s: not s['totals']['waiting'])
            self.assertEqual((self.root / 'remote' / 'dos.txt').read_text(), 'nuevo dos.txt')
            # And several deleted at once on the server.
            gone = ['uno.txt', 'uno (2).txt', 'dos.txt']
            worker.rpc(action='delete', names=gone, confirm=gone)
            state = worker.until(lambda s: not s['busy'] and s['message'].startswith('Deleted'))
            self.assertEqual(sorted(p.name for p in (self.root / 'remote').iterdir()), ['hola.txt', 'tres.txt'])
        finally:
            worker.close()

    def test_cancel_all_and_retry(self):
        local = Path(self.temp.name) / 'local'
        local.mkdir()
        for i in range(3):
            (self.root / 'remote' / f'g{i}.bin').write_bytes(os.urandom(4 * 1024 * 1024))
        worker = self.connected()
        try:
            worker.rpc(action='local_list', path=str(local))
            worker.rpc(action='enqueue', kind='download', items=[dict(name=f'g{i}.bin', size=4 << 20) for i in range(3)])
            worker.until(lambda s: s['transfer'] and s['transfer']['done'] > 0)
            worker.rpc(action='cancel_all')
            state = worker.until(lambda s: not s['totals']['waiting'])
            self.assertEqual(state['totals']['cancelled'], 3)
            self.assertFalse([p for p in local.iterdir()])  # no partial or temporary files
            worker.rpc(action='retry')
            state = worker.until(lambda s: s['totals']['done'] == 3, seconds=30)
            self.assertEqual(sorted(p.name for p in local.iterdir()), ['g0.bin', 'g1.bin', 'g2.bin'])
            worker.rpc(action='clear')
            state = worker.until(lambda s: s['totals']['files'] == 0)
        finally:
            worker.close()

    def test_wrong_password_and_refused_hostkey(self):
        worker = Worker('test', '/dev/null')
        try:
            self.answer(worker, 'hostkey', 'yes')
            self.answer(worker, 'secret', 'mala')
            state = worker.until(lambda s: not s['busy'])
            self.assertFalse(state['ready'])
            self.assertIn('rejected the password', state['error'])
        finally:
            worker.close()
        worker = Worker('test', '/dev/null')
        try:
            self.answer(worker, 'hostkey', 'no')
            state = worker.until(lambda s: not s['busy'])
            self.assertIn('fingerprint', state['error'])
        finally:
            worker.close()


if __name__ == '__main__':
    unittest.main()
