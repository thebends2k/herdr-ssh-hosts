"""SSH_ASKPASS for the SFTP view: OpenSSH runs this (through askpass.sh or
askpass.cmd) when it needs a password, a key passphrase or a host-key
decision. It hands the question to the worker that started ssh and prints
the answer the person gave in Herdr's dialog. Nothing is stored.
"""
import json
import os
import re
import sys
import urllib.request


def main():
    prompt = ' '.join(sys.argv[1:]).strip()
    url, token = os.environ.get('HERDR_SFTP_URL'), os.environ.get('HERDR_SFTP_TOKEN')
    if not url or not token:
        return 1
    mode = os.environ.get('SSH_ASKPASS_PROMPT', '')
    if re.search(r'\(yes/no', prompt):
        kind = 'hostkey'   # answer "yes" or "no"
    elif mode == 'confirm':
        kind = 'approve'   # exit status is the answer
    elif mode == 'none':
        kind = 'info'      # a notice; ssh kills this when done
    else:
        kind = 'secret'
    request = urllib.request.Request(url + '/askpass', method='POST',
                                     data=json.dumps(dict(prompt=prompt, kind=kind)).encode(),
                                     headers={'Authorization': 'Bearer ' + token,
                                              'Content-Type': 'application/json'})
    # Loopback only: never through a proxy from the environment.
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    try:
        with opener.open(request, timeout=330) as response:
            reply = json.loads(response.read())
    except Exception:
        return 1
    if not reply.get('ok'):
        return 1
    sys.stdout.write(reply.get('answer') or '')
    sys.stdout.write('\n')
    return 0


if __name__ == '__main__':
    sys.exit(main())
