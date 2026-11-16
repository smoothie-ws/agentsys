from pathlib import Path
import json
c = Path(__file__).resolve().parents[2] / 'agentsys-client'
p = c / 'js/app/environments.js'
t = p.read_text()
a = t.index("    if (typeof location !== 'undefined'", t.index('const defaultURL'))
b = t.index('\n  };', a)
t = t[:a] + "    return '';" + t[b:]
t = t.replace('    if (!environments.length) {', "    if (!environments.length && !defaultURL()) return null;\n    if (!environments.length) {", 1)
t = t.replace('    const env = target || active || ensureDefaults();', "    const env = target || active || ensureDefaults();\n    if (!env) throw new ApiError('disconnected', 'Add a server in Environments to connect.', 503);")
t = t.replace('    if (!env) env = ensureDefaults();', "    if (!env) env = ensureDefaults();\n    if (!env) { beginGeneration(); setStatus('disconnected', 'Add a server in Environments to connect.'); return false; }")
t = t.replace('      ensureDefaults();\n      return connect(active);', "      await globalThis.AGENTSYS_CONFIG_READY;\n      ensureDefaults();\n      return connect(active);")
t = t.replace("if (!PROTOCOL.compatible(value.protocol))", "if (!PROTOCOL.compatible(value.protocol) || (value.api_version !== undefined && !PROTOCOL.compatibleAPI(value.api_version)))")
p.write_text(t)
p = c / 'tests/environments.test.js'
t = p.read_text().replace('function makeEnvironment(handler)', "function makeEnvironment(handler, defaultServer = 'http://client.test')")
t = t.replace('    console,\n    localStorage,', '    console,\n    AGENTSYS_DEFAULT_SERVER: defaultServer,\n    localStorage,')
t += '''
test('a fresh static installation stays disconnected until a server is supplied', async () => {
  const {Environment, requests} = makeEnvironment(() => { throw new Error('Unexpected request'); }, '');
  assert.equal(await Environment.start(), false);
  assert.equal(Environment.status().status, 'disconnected');
  assert.equal(Environment.list().length, 0);
  assert.equal(Environment.defaultURL(), '');
  assert.equal(requests.length, 0);
  await assert.rejects(Environment.request('GET', 'projects'), {code: 'disconnected'});
});
test('API compatibility accepts minor additions independently of application releases', () => {
  assert.equal(Protocol.compatibleAPI('2.0'), true);
  assert.equal(Protocol.compatibleAPI('2.42'), true);
  for (const value of ['3.0', '1.9', '', null, '2.x']) assert.equal(Protocol.compatibleAPI(value), false);
});
'''
p.write_text(t)
(c / 'config.json').write_text('{"defaultServerURL":""}\n')
(c / 'js/app/config.js').write_text('''// Public deployment configuration. Contains no tokens or secrets.
'use strict';
globalThis.AGENTSYS_CONFIG_READY = (async () => {
  try {
    const response = await fetch(new URL('../../config.json', document.currentScript.src), {cache: 'no-store', signal: AbortSignal.timeout(5000)});
    if (!response.ok) return;
    const config = await response.json();
    if (!globalThis.AGENTSYS_DEFAULT_SERVER && typeof config.defaultServerURL === 'string' && config.defaultServerURL) {
      const url = new URL(config.defaultServerURL);
      if (['http:', 'https:'].includes(url.protocol) && !url.username && !url.password)
        globalThis.AGENTSYS_DEFAULT_SERVER = config.defaultServerURL;
    }
  } catch { /* An unavailable or invalid optional configuration leaves the client disconnected. */ }
})();
''')
p = c / 'index.html'
t = p.read_text().replace('<script defer src="js/app/environments.js">', '<script defer src="js/app/config.js"></script>\n  <script defer src="js/app/environments.js">')
p.write_text(t)
p = c / 'client/public-files.json'
v = json.loads(p.read_text()); v.extend(['config.json', 'js/app/config.js']); p.write_text(json.dumps(sorted(set(v)), indent=2)+'\n')
p = c / 'bin/agentsys-client.js'
t = p.read_text().replace("const Protocol = require('../js/app/protocol');", "const Protocol = {VERSION: require('../package.json').version, CLIENT_PORT: 8081};")
t = t.replace("const ROOT = path.resolve(__dirname, '..');", "const ROOT = path.resolve(__dirname, '../dist/client');")
t = t.replace("process.env.AGENTSYS_DEFAULT_SERVER || 'http://127.0.0.1:' + Protocol.DEFAULT_PORT", "process.env.AGENTSYS_DEFAULT_SERVER || ''")
t = t.replace("    if (flag === '--port'", "    if (flag === 'serve') continue;\n    if (flag === '--port'")
t = t.replace('    const url = new URL(options.server);', '    const url = options.server ? new URL(options.server) : null;').replace("if (!['http:', 'https:'].includes(url.protocol))", "if (url && (!['http:', 'https:'].includes(url.protocol) || url.username || url.password))")
p.write_text(t)
