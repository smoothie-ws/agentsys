from pathlib import Path
import shutil, json

base = Path(__file__).resolve().parents[1]
c = base.parent / 'agentsys-client'
s = base.parent / 'agentsys-server'
p = c / 'tests/environments.test.js'
p.write_text(p.read_text().replace("'shared', 'core.js'", "'js', 'app', 'core.js'"))
shutil.copytree(base / 'examples/hello-plugin', c / 'examples/hello-plugin', dirs_exist_ok=True)
p = c / 'js/app/core.js'
t = p.read_text()
t = t[:t.index('function checkManifest(')]
t = t.replace('// Helpers every layer uses.', '// Client presentation and editing helpers.')
p.write_text(t)
p = c / 'sdk/package.json'
v = json.loads(p.read_text())
v.pop('private', None)
p.write_text(json.dumps(v, indent=2) + '\n')
for target, product in [(s, 'server'), (c, 'client')]:
    workflow = target / '.github/workflows/ci.yml'
    workflow.parent.mkdir(parents=True, exist_ok=True)
    workflow.write_text('''name: Independent product CI
on: [push, pull_request, workflow_dispatch]
permissions:
  contents: read
jobs:
  test:
    strategy:
      fail-fast: false
      matrix:
        os: [ubuntu-latest, windows-latest]
        node: [22, 24]
    runs-on: ${{ matrix.os }}
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: ${{ matrix.node }}
      - run: npm test -- --test-concurrency=1
''' + ('      - run: npm run build\n' if product == 'client' else '') + '''      - run: npm pack --ignore-scripts
      - uses: actions/upload-artifact@v4
        with:
          name: ''' + product + '''-${{ matrix.os }}-${{ matrix.node }}
          path: '*.tgz'
''')
    (target / 'README.md').write_text('# AgentSys ' + product.title() + '\n\nIndependent product.\n\nNode.js 22+ for CLI and development.\n\n```sh\nnpm test\n' + ('node bin/agentsys-server.js start --port 8080 --data ./data\n' if product == 'server' else 'npm run build\nnode bin/agentsys-client.js --port 8081 --server https://server.example.com\n') + '```\n\n' + ('The server serves HTTP API and SSE only. No GUI files are installed.\n' if product == 'server' else 'Deploy dist/client to any static host. Production static hosting requires no Node.js.\n') + '\nSource provenance: MIGRATION.md.\n')
    with (target / '.gitignore').open('a') as f:
        f.write('extraction-tests.txt\n*.tgz\n')
