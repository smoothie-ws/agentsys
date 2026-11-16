"""Create only the explicitly requested product repositories using existing Git credentials.

Credentials are held in memory and never printed or written to disk. Existing
repositories are inspected, never overwritten. No force push is performed.
"""
import json, os, subprocess, urllib.request, urllib.error

env = dict(os.environ, GIT_TERMINAL_PROMPT='0', GCM_INTERACTIVE='never')
credential = subprocess.run(['git', 'credential', 'fill'], input='protocol=https\nhost=github.com\n\n', text=True, capture_output=True, env=env, timeout=20)
values = dict(line.split('=', 1) for line in credential.stdout.splitlines() if '=' in line)
token = values.get('password')
if not token:
    print('No noninteractive GitHub credential is available; local repositories remain usable.')
    raise SystemExit(2)

def api(method, route, body=None):
    request = urllib.request.Request('https://api.github.com' + route, method=method, headers={'Authorization': 'Bearer ' + token, 'Accept': 'application/vnd.github+json', 'User-Agent': 'AgentSys-product-migration', 'Content-Type': 'application/json'}, data=None if body is None else json.dumps(body).encode())
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            return response.status, json.load(response)
    except urllib.error.HTTPError as error:
        return error.code, {}

status, original = api('GET', '/repos/smoothie-ws/agentsys')
if status != 200:
    print('Cannot inspect source repository permissions: HTTP', status)
    raise SystemExit(2)
status, me = api('GET', '/user')
owner = original['owner']
if owner['type'] != 'Organization' and me.get('login', '').lower() != owner['login'].lower():
    print('The Git credential cannot create repositories in the requested personal account.')
    raise SystemExit(2)
for product in ['server', 'client']:
    name = 'agentsys-' + product
    status, repository = api('GET', '/repos/smoothie-ws/' + name)
    if status == 404:
        route = '/orgs/smoothie-ws/repos' if owner['type'] == 'Organization' else '/user/repos'
        status, repository = api('POST', route, {'name': name, 'private': original['private'], 'description': 'Independent AgentSys ' + product, 'auto_init': False})
        if status != 201:
            print(name + ': creation unavailable, HTTP ' + str(status))
            continue
        print(name + ': created ' + repository['html_url'])
    elif status == 200:
        print(name + ': exists ' + repository['html_url'])
    else:
        print(name + ': inspection unavailable, HTTP ' + str(status))
