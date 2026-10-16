#!/usr/bin/env python3
"""Forced SSH command: deploy only the canonical Milo revision through Dokploy."""
from pathlib import Path
import json
import os
import re
import subprocess
import sys
import time
import urllib.request

COMPOSE_ID = '6eWcdxRDYjK5biNT6_NSt'


def replace_revision(environment, revision):
    lines = [line for line in environment.splitlines() if not line.startswith('MILO_BUILD_REVISION=')]
    return '\n'.join(lines).rstrip() + '\nMILO_BUILD_REVISION=' + revision + '\n'


def main():
    command = re.fullmatch(r'deploy ([0-9a-f]{40})', os.environ.get('SSH_ORIGINAL_COMMAND', ''))
    if not command:
        raise ValueError('Only a canonical Milo deployment is allowed')
    if subprocess.check_output(['hostname'], text=True).strip() != 'srv1903452':
        raise ValueError('Unexpected deployment host')
    revision = command[1]
    import fcntl
    lock = Path('/var/lock/seemplify-production-deploy.lock').open('a')
    fcntl.flock(lock, fcntl.LOCK_EX)
    token = Path('/opt/seemplify/secrets/github-deploy-token').read_text().strip()
    request = urllib.request.Request('https://api.github.com/repos/michaelegbo/milo/git/ref/heads/main',
        headers={'Authorization': 'Bearer ' + token, 'Accept': 'application/vnd.github+json'})
    with urllib.request.urlopen(request, timeout=30) as response:
        if json.load(response)['object']['sha'] != revision:
            raise ValueError('Requested revision is no longer canonical main')
    key = Path('/opt/seemplify/secrets/dokploy-ci-api-key').read_text().strip()

    def api(route, body=None):
        config = 'header = ' + json.dumps('x-api-key: ' + key) + '\n'
        if body is not None:
            config += 'header = "Content-Type: application/json"\nrequest = "POST"\n'
            config += 'data = ' + json.dumps(json.dumps(body)) + '\n'
        result = subprocess.run(['curl', '--fail', '--silent', '--show-error', '--max-time', '60',
            '--resolve', 'dokploy.seemplifyai.com:443:127.0.0.1', '--config', '-',
            'https://dokploy.seemplifyai.com/api/' + route], input=config, capture_output=True, text=True)
        if result.returncode:
            raise RuntimeError('Dokploy operation failed')
        return json.loads(result.stdout) if result.stdout else None

    compose = api('compose.one?composeId=' + COMPOSE_ID)
    if compose.get('customGitBranch') != 'main' or compose.get('appName') != 'milo-web-s0mht6':
        raise ValueError('Unexpected Milo deployment configuration')
    before = compose.get('env') or ''
    backup = Path('/opt/seemplify-autodeploy/20261016/milo-environment-before.env')
    if not backup.exists():
        backup.write_text(before)
        backup.chmod(0o600)
    api('compose.saveEnvironment', {'composeId': COMPOSE_ID, 'env': replace_revision(before, revision)})
    api('compose.deploy', {'composeId': COMPOSE_ID})
    for _ in range(360):
        result = subprocess.run(['curl', '--fail', '--silent', '--show-error', '--max-time', '20',
            '--resolve', 'milo.seemplifyai.com:443:127.0.0.1',
            'https://milo.seemplifyai.com/release.json'], capture_output=True, text=True)
        try:
            if result.returncode == 0 and json.loads(result.stdout).get('revision') == revision:
                ids = subprocess.check_output(['docker', 'ps', '-q', '--filter',
                    'label=com.docker.compose.project=milo-web-s0mht6'], text=True).splitlines()
                details = json.loads(subprocess.check_output(['docker', 'inspect'] + ids)) if ids else []
                if len(details) == 3 and all(c['State'].get('Health', {}).get('Status') == 'healthy'
                    and c['Config']['Labels'].get('org.opencontainers.image.revision') == revision for c in details):
                    print('milo_revision=' + revision + ' host=191.215.40.99 services=3 healthy=true')
                    return
        except (ValueError, KeyError):
            pass
        time.sleep(5)
    raise RuntimeError('Exact healthy Milo revision did not become ready')


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        print('Milo deployment failed: ' + type(error).__name__, file=sys.stderr)
        sys.exit(1)
