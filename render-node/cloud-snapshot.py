#!/usr/bin/env python3
"""Builds the snapshot of the render servers in the cloud (WP54, lib/cloud-render.js) at Hetzner Cloud.

Python 3 without extra packages; ssh must be installed and the private key of the SSH key of the Hetzner project loaded
(ssh-agent) or given with --identity.

  python3 render-node/cloud-snapshot.py --ssh-key <name or id> --server <address of the app> --code <code> [--type cpx42]
      [--location nbg1] [--identity ~/.ssh/id_ed25519] [--token-file <file>] [--dry-run]

The steps: a fresh server from ubuntu-24.04 (label ocd-render=build), wait until SSH answers, upload render-node/cloud-image.sh
and run it (it fetches the agent package with the pairing code of an admin from "My computers"; the code is only checked, not
used up), read the versions it wrote, then «sync; systemctl poweroff» inside the server (never the API action poweroff: it cuts
the power, and files written in the last seconds were empty in a snapshot), wait until the server is off, take the snapshot
with a description and labels (ocd-render=image, ocd-hyperframes, ocd-node), wait until it is available, delete the server
and print the new snapshot id. On any error, and on Ctrl-C, the server is deleted (a server is billed per hour begun).

The API token is read from a file (--token-file, else HETZNER_TOKEN_FILE, else ~/.config/hetzner/render-token). It is never
printed and never passed in the arguments of a process; an error text that would contain it shows [token] instead.
--dry-run only shows the planned steps: it reads no token and calls nothing.
"""

import argparse
import json
import os
import re
import secrets
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request

API_BASE = 'https://api.hetzner.cloud/v1'
DEFAULT_TOKEN_FILE = '~/.config/hetzner/render-token'
IMAGE = 'ubuntu-24.04'
IMAGE_FILE = '/usr/local/lib/ocd-render/image.json'
LABEL_VALUE = re.compile(r'^[A-Za-z0-9]([A-Za-z0-9._-]{0,61}[A-Za-z0-9])?$')
HERE = os.path.dirname(os.path.abspath(__file__))


class BuildError(Exception):
    pass


def read_token(path):
    try:
        with open(os.path.expanduser(path), encoding='utf-8') as handle:
            token = handle.read().strip()
    except OSError as err:
        raise BuildError(f'The token file cannot be read ({err.strerror}).') from None
    if not re.fullmatch(r'[A-Za-z0-9_-]{20,128}', token):
        raise BuildError('The token file does not hold a Hetzner API token.')
    return token


def make_api(token, base=API_BASE, timeout=60):
    """A function (method, path, body) -> answer of the Hetzner API; raises BuildError with a text without the token."""

    def redact(text):
        return str(text).replace(token, '[token]')[:300]

    def api(method, path, body=None):
        data = json.dumps(body).encode() if body is not None else None
        request = urllib.request.Request(base + path, method=method, data=data, headers={
            'Authorization': 'Bearer ' + token,
            'Content-Type': 'application/json',
        })
        try:
            with urllib.request.urlopen(request, timeout=timeout) as answer:
                raw = answer.read()
                return json.loads(raw) if raw else {}
        except urllib.error.HTTPError as err:
            try:
                detail = json.loads(err.read() or b'{}').get('error', {})
            except ValueError:
                detail = {}
            raise BuildError(redact(f'Hetzner {method} {path}: HTTP {err.code} {detail.get("code", "")} {detail.get("message", "")}'.strip())) from None
        except (urllib.error.URLError, OSError) as err:
            raise BuildError(redact(f'Hetzner {method} {path}: {getattr(err, "reason", err)}')) from None

    return api


def make_ssh(identity=None, known_hosts=None):
    """A function (ip, command, stdin=None, timeout) -> (exit code, stdout) that runs a command as root on the server."""

    def ssh(ip, command, stdin=None, timeout=600):
        args = ['ssh', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', '-o', 'StrictHostKeyChecking=accept-new',
                '-o', f'UserKnownHostsFile={known_hosts or os.devnull}', '-o', 'LogLevel=ERROR']
        if identity:
            args += ['-i', os.path.expanduser(identity), '-o', 'IdentitiesOnly=yes']
        args += [f'root@{ip}', command]
        try:
            done = subprocess.run(args, input=stdin, stdout=subprocess.PIPE, timeout=timeout, check=False)
        except subprocess.TimeoutExpired:
            return 124, b''
        return done.returncode, done.stdout

    return ssh


def shell_quote(value):
    return "'" + str(value).replace("'", "'\"'\"'") + "'"


class Builder:
    """The steps of one build. api, ssh, sleep and clock are given, so a test can replace Hetzner and the server."""

    def __init__(self, options, api, ssh, sleep=time.sleep, clock=time.monotonic, out=print):
        self.options = options
        self.api = api
        self.ssh = ssh
        self.sleep = sleep
        self.clock = clock
        self.out = out
        self.server_id = None
        self.build_id = secrets.token_hex(12)
        self.create_attempted = False

    def wait(self, what, check, timeout, every=5):
        deadline = self.clock() + timeout
        while True:
            result = check()
            if result:
                return result
            if self.clock() >= deadline:
                raise BuildError(f'Timeout: {what}.')
            self.sleep(every)

    def wait_action(self, action, what, timeout=900):
        if not action or not action.get('id'):
            return

        def done():
            state = self.api('GET', f'/actions/{action["id"]}').get('action', {})
            if state.get('status') == 'error':
                raise BuildError(f'{what}: {state.get("error", {}).get("message", "error")}')
            return state.get('status') == 'success'

        self.wait(what, done, timeout)

    def create_server(self):
        options = self.options
        key = int(options.ssh_key) if str(options.ssh_key).isdigit() else options.ssh_key
        name = f'ocd-render-build-{self.build_id}'
        self.create_attempted = True
        answer = self.api('POST', '/servers', {
            'name': name,
            'server_type': options.type,
            'image': IMAGE,
            'location': options.location,
            'ssh_keys': [key],
            'start_after_create': True,
            'labels': {'ocd-render': 'build', 'ocd-build': self.build_id},
        })
        server = answer.get('server') or {}
        if not server.get('id'):
            raise BuildError('Hetzner returned no server id.')
        self.server_id = server['id']
        self.out(f'Server {name} (#{self.server_id}, {options.type}, {options.location}) created.')
        self.wait_action(answer.get('action'), 'create the server')
        ip = ((server.get('public_net') or {}).get('ipv4') or {}).get('ip')
        if not ip:
            ip = (((self.api('GET', f'/servers/{self.server_id}').get('server') or {}).get('public_net') or {}).get('ipv4') or {}).get('ip')
        if not ip:
            raise BuildError('The server has no IPv4 address.')
        return ip

    def run_image_script(self, ip):
        self.wait('SSH on the new server', lambda: self.ssh(ip, 'true', timeout=30)[0] == 0, self.options.ssh_timeout, every=5)
        self.out('SSH answers. Running cloud-image.sh (a few minutes) …')
        with open(self.options.script, 'rb') as handle:
            script = handle.read()
        code, _ = self.ssh(ip, 'cat > /root/cloud-image.sh && chmod 700 /root/cloud-image.sh', stdin=script, timeout=120)
        if code != 0:
            raise BuildError(f'cloud-image.sh could not be uploaded (ssh {code}).')
        command = f'bash /root/cloud-image.sh --server {shell_quote(self.options.server)} --code {shell_quote(self.options.code)} </dev/null && rm -f /root/cloud-image.sh'
        code, _ = self.ssh(ip, command, timeout=self.options.script_timeout)
        if code != 0:
            raise BuildError(f'cloud-image.sh failed (exit {code}).')
        code, raw = self.ssh(ip, f'cat {IMAGE_FILE}', timeout=60)
        try:
            versions = json.loads(raw or b'{}') if code == 0 else {}
        except ValueError:
            versions = {}
        return versions if isinstance(versions, dict) else {}

    def power_off(self, ip):
        # inside the server: everything onto the disk, then a clean shutdown (the connection ends with it, ssh says 255)
        self.ssh(ip, 'sync; systemctl poweroff', timeout=60)

        def off():
            return (self.api('GET', f'/servers/{self.server_id}').get('server') or {}).get('status') == 'off'

        self.wait('the server switches off', off, self.options.off_timeout)
        self.out('The server is off.')

    def snapshot(self, versions):
        hyperframes = str(versions.get('hyperframes') or 'unknown')
        node = str(versions.get('node') or 'unknown')
        labels = {'ocd-render': 'image'}
        for key, value in (('ocd-hyperframes', hyperframes), ('ocd-node', node)):
            if LABEL_VALUE.match(value):
                labels[key] = value
        description = f'ocd-render-agent (cloud-image.sh, HyperFrames {hyperframes}, Node.js {node}, {time.strftime("%Y-%m-%d", time.gmtime())})'
        answer = self.api('POST', f'/servers/{self.server_id}/actions/create_image', {'type': 'snapshot', 'description': description, 'labels': labels})
        image_id = (answer.get('image') or {}).get('id')
        if not image_id:
            raise BuildError('Hetzner returned no image id.')
        self.out(f'Snapshot {image_id} is being made …')
        self.wait_action(answer.get('action'), 'create the snapshot', timeout=self.options.image_timeout)
        self.wait('the snapshot is available', lambda: (self.api('GET', f'/images/{image_id}').get('image') or {}).get('status') == 'available', self.options.image_timeout)
        return image_id

    def delete_server(self):
        if not self.create_attempted:
            return
        last_error = None
        for attempt in range(3):
            try:
                if not self.server_id:
                    answer = self.api('GET', f'/servers?label_selector=ocd-render%3Dbuild%2Cocd-build%3D{self.build_id}')
                    servers = answer.get('servers')
                    if not isinstance(servers, list):
                        raise BuildError('Incomplete server list during cleanup.')
                    if not servers:
                        if attempt < 2:
                            self.sleep(5)
                            continue
                        return
                    self.server_id = servers[0]['id']
                self.api('DELETE', f'/servers/{self.server_id}')
                self.out(f'Server #{self.server_id} deleted.')
                self.server_id = None
                return
            except BuildError as err:
                last_error = err
                if attempt < 2:
                    self.sleep(5)
        raise BuildError(f'Cleanup failed for server #{self.server_id or "unknown"} (build {self.build_id}); delete it in the Hetzner Console: {last_error}')

    def run(self):
        try:
            ip = self.create_server()
            versions = self.run_image_script(ip)
            self.power_off(ip)
            image_id = self.snapshot(versions)
        except BaseException:
            self.delete_server()
            raise
        self.delete_server()
        return image_id


def plan(options):
    script = os.path.relpath(options.script)
    return [
        f'Read the API token from {options.token_file} (never shown).',
        f'POST /servers: a fresh server from {IMAGE}, type {options.type}, location {options.location}, SSH key {options.ssh_key}, label ocd-render=build.',
        f'Wait until SSH answers (at most {options.ssh_timeout // 60} min).',
        f'Upload {script} and run it: --server {options.server} --code <code>.',
        f'Read {IMAGE_FILE} (the versions of the snapshot).',
        'Inside the server: sync; systemctl poweroff (never the API action poweroff).',
        'Wait until the server is off.',
        'POST /servers/{id}/actions/create_image: snapshot with description and labels ocd-render=image, ocd-hyperframes, ocd-node.',
        'Wait until the snapshot is available.',
        'DELETE /servers/{id}, print the snapshot id (enter it in the app: Settings → Rendering → Render servers at Hetzner).',
        'On any error: DELETE /servers/{id}.',
    ]


def parse_args(argv):
    parser = argparse.ArgumentParser(description='Builds the snapshot of the render servers at Hetzner Cloud.')
    parser.add_argument('--type', default='cpx42', help='server type (default cpx42)')
    parser.add_argument('--location', default='nbg1', help='location (default nbg1)')
    parser.add_argument('--ssh-key', required=True, help='name or id of an SSH key of the Hetzner project')
    parser.add_argument('--identity', help='private key for ssh (default: ssh-agent and the usual keys)')
    parser.add_argument('--server', required=True, help='public address of the app (PUBLIC_BASE_URL)')
    parser.add_argument('--code', default=os.environ.get('OCD_CODE', ''), help='pairing code of an admin ("My computers"), or OCD_CODE')
    parser.add_argument('--token-file', default=os.environ.get('HETZNER_TOKEN_FILE') or DEFAULT_TOKEN_FILE, help='file with the API token (or HETZNER_TOKEN_FILE)')
    parser.add_argument('--script', default=os.path.join(HERE, 'cloud-image.sh'), help=argparse.SUPPRESS)
    parser.add_argument('--dry-run', action='store_true', help='only show the planned steps')
    options = parser.parse_args(argv)
    options.ssh_timeout = 600
    options.script_timeout = 45 * 60
    options.off_timeout = 300
    options.image_timeout = 45 * 60
    if not re.fullmatch(r'[a-z0-9-]{2,30}', options.type):
        parser.error('invalid --type')
    if not re.fullmatch(r'[a-z0-9-]{2,20}', options.location):
        parser.error('invalid --location')
    if not re.fullmatch(r'[A-Za-z0-9 ._@-]{1,64}', options.ssh_key):
        parser.error('invalid --ssh-key')
    if not re.fullmatch(r'https?://[A-Za-z0-9.:\[\]/_-]{1,300}', options.server):
        parser.error('invalid --server')
    if not options.dry_run and not re.fullmatch(r'[A-Za-z0-9]{4}-?[A-Za-z0-9]{4}', options.code.strip()):
        parser.error('--code (or OCD_CODE) needs the pairing code of an admin')
    options.code = options.code.strip()
    return options


def main(argv=None):
    options = parse_args(sys.argv[1:] if argv is None else argv)
    if options.dry_run:
        print('Dry run, nothing is called:')
        for number, step in enumerate(plan(options), 1):
            print(f'{number:2}. {step}')
        return 0
    try:
        token = read_token(options.token_file)
    except BuildError as err:
        print(f'Error: {err}', file=sys.stderr)
        return 1
    with tempfile.TemporaryDirectory(prefix='ocd-snapshot-') as folder:
        builder = Builder(options, make_api(token), make_ssh(options.identity, os.path.join(folder, 'known_hosts')))
        try:
            image_id = builder.run()
        except KeyboardInterrupt:
            print('Stopped.', file=sys.stderr)
            return 130
        except Exception as err:  # the server is deleted already (Builder.run); the text never carries the token
            print(f'Error: {str(err).replace(token, "[token]")[:300]}', file=sys.stderr)
            return 1
    print(f'New snapshot id: {image_id}')
    return 0


if __name__ == '__main__':
    sys.exit(main())
