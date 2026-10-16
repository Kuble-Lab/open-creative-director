#!/usr/bin/env python3
"""List expired render/build servers; delete only with --delete.

Uses the same token file as cloud-snapshot.py, or with --settings-file the
token in the app's cloud settings (data/cloud-render/settings.json), so a
scheduled run needs no second copy of it. The default dry run reads the
cloud API but never changes it. --server limits cleanup to an app's origin;
without it, all explicitly labelled, expired servers in the token's project
are eligible. Legacy servers without a valid expiry label are left alone.
"""

import argparse
import hashlib
import importlib.util
import json
import os
import re
import sys
import time
import urllib.parse

_spec = importlib.util.spec_from_file_location('cloud_snapshot', os.path.join(os.path.dirname(__file__), 'cloud-snapshot.py'))
_snapshot = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_snapshot)


def expired(server, now, origin=None):
    labels = server.get('labels') or {}
    expiry = labels.get('ocd-expires', '')
    return (labels.get('ocd-render') in ('cloud', 'build')
            and (origin is None or labels.get('ocd-origin') == origin)
            and isinstance(expiry, str) and re.fullmatch(r'[0-9]{1,12}', expiry) is not None
            and 0 < int(expiry) <= now
            and isinstance(server.get('id'), int) and server['id'] > 0)


def cleanup(api, delete=False, server=None, now=None, out=print):
    now = time.time() if now is None else now
    origin = hashlib.sha256(server.rstrip('/').encode()).hexdigest()[:32] if server else None
    candidates = {}
    # Finish pagination before deleting: removing items while paging could skip servers.
    for kind in ('cloud', 'build'):
        page = 1
        seen = set()
        while page is not None:
            if not isinstance(page, int) or page < 1 or page > 10000 or page in seen:
                raise _snapshot.BuildError('Invalid server pagination.')
            seen.add(page)
            selector = urllib.parse.quote('ocd-render=' + kind, safe='')
            answer = api('GET', f'/servers?label_selector={selector}&per_page=50&page={page}')
            servers = answer.get('servers')
            if not isinstance(servers, list):
                raise _snapshot.BuildError('Incomplete server list during cleanup.')
            for item in servers:
                if expired(item, now, origin):
                    candidates[item['id']] = item
            page = ((answer.get('meta') or {}).get('pagination') or {}).get('next_page')
    failed = False
    for ident, item in candidates.items():
        labels = item['labels']
        if delete:
            try:
                # Re-read before deleting: the expiry or ownership may have changed.
                current = api('GET', f'/servers/{ident}').get('server') or {}
                if current.get('id') != ident or not expired(current, now, origin):
                    out(f'Skip #{ident}: labels changed.')
                    continue
                api('DELETE', f'/servers/{ident}')
                out(f'Delete requested: #{ident}.')
            except _snapshot.BuildError as err:
                failed = True
                out(f'Cleanup failed for #{ident}: {err}')
        else:
            out(f'Dry run: #{ident}, {labels["ocd-render"]}, expires={labels["ocd-expires"]}.')
    return 1 if failed else 0


def read_settings_token(path):
    """The API token from the app's cloud settings file (a JSON object with "token")."""
    try:
        with open(os.path.expanduser(path), encoding='utf-8') as handle:
            settings = json.load(handle)
    except OSError as err:
        raise _snapshot.BuildError(f'The settings file cannot be read ({err.strerror}).') from None
    except ValueError:
        raise _snapshot.BuildError('The settings file is not valid JSON.') from None
    token = settings.get('token') if isinstance(settings, dict) else None
    if not isinstance(token, str) or not re.fullmatch(r'[A-Za-z0-9_-]{20,128}', token.strip()):
        raise _snapshot.BuildError('The settings file does not hold a Hetzner API token.')
    return token.strip()


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument('--dry-run', action='store_true', help='list only (default)')
    mode.add_argument('--delete', action='store_true', help='delete expired labelled servers')
    parser.add_argument('--server', help='limit to this public app address (same as snapshot --server)')
    source = parser.add_mutually_exclusive_group()
    source.add_argument('--token-file', default=os.environ.get('HETZNER_TOKEN_FILE') or _snapshot.DEFAULT_TOKEN_FILE)
    source.add_argument('--settings-file', help="read the token from the app's cloud settings (data/cloud-render/settings.json)")
    options = parser.parse_args(argv)
    token = None
    try:
        token = read_settings_token(options.settings_file) if options.settings_file else _snapshot.read_token(options.token_file)
        return cleanup(_snapshot.make_api(token), delete=options.delete, server=options.server)
    except (Exception, KeyboardInterrupt) as err:
        message = str(err).replace(token, '[token]') if token else str(err)
        print(f'Error: {message[:300]}', file=sys.stderr)
        return 130 if isinstance(err, KeyboardInterrupt) else 1


if __name__ == '__main__':
    sys.exit(main())
