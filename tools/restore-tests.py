from pathlib import Path
import re, json
base = Path(__file__).resolve().parents[1]
s = base.parent / 'agentsys-server'
c = base.parent / 'agentsys-client'
for name in ['deployment', 'format-property', 'graph-format', 'platform', 'security', 'soak', 'plugin-tokens', 'widgets']:
    text = (base / f'tests/{name}.test.js').read_text(encoding='utf-8-sig')
    text = text.replace('../shared/', '../runtime/').replace('../js/storage/', '../runtime/storage/').replace('js/backend/', 'runtime/backend/').replace('js/model/', 'runtime/model/')
    if name == 'platform':
        start = text.index('  const html =')
        end = text.index('\n});', start)
        text = text[:start] + "  assert.equal(fs.existsSync(path.join(__dirname, '..', 'index.html')), false);" + text[end:]
    if name == 'security':
        text = text.replace("require('../runtime/protocol').VERSION", "require('../runtime/protocol').API_VERSION")
    if name == 'plugin-tokens':
        text = text[:text.index("test('the host matcher")]
    if name == 'widgets':
        start = text.index("  const {renderMarkdown} =")
        end = text.index("\ntest('markdownSlug", start)
        client_test = "const test = require('node:test');\nconst assert = require('node:assert/strict');\ntest('markdown rendering escapes unsafe content and preserves formatting', () => {\n" + text[start:end] + text[end:]
        (c / 'tests/markdown.test.js').write_text(client_test)
        text = text[:start] + '\n});\n'
    (s / f'tests/{name}.test.js').write_text(text)
for name in ['format-property', 'graph-format', 'client-plugins', 'static-serving']:
    text = (base / f'tests/{name}.test.js').read_text(encoding='utf-8-sig')
    text = text.replace("'shared', 'core.js'", "'js', 'app', 'core.js'").replace('/shared/core.js', '/js/app/core.js').replace('../server/static-assets', '../client/static-assets')
    (c / f'tests/{name}.test.js').write_text(text)
cases = [
    {'grants':['graph.read'],'need':'graph.read','allowed':True},
    {'grants':['graph.read'],'need':'graph.write','allowed':False},
    {'grants':['net.fetch:*.example.com'],'need':'net.fetch:api.example.com','allowed':True},
    {'grants':['net.fetch:*.example.com'],'need':'net.fetch:example.com.evil.test','allowed':False},
    {'grants':['secrets.use:one'],'need':'secrets.use:two','allowed':False},
    {'grants':['graph.*'],'need':'graph.read','allowed':True},
    {'grants':[],'need':'graph.read','allowed':False}
]
for target, module, method in [(s,'../runtime/core','capabilityAllows'), (c,'../js/app/plugin-capabilities','allows')]:
    fixtures = target / 'contract-fixtures'
    fixtures.mkdir(exist_ok=True)
    (fixtures / 'capabilities.json').write_text(json.dumps(cases,indent=2)+'\n')
    (target / 'tests/capability-contract.test.js').write_text("const test=require('node:test'), assert=require('node:assert/strict');\nconst matcher=require('"+module+"')."+method+";\nconst cases=require('../contract-fixtures/capabilities.json');\ntest('capabilities follow public conformance fixtures',()=>{for(const item of cases) assert.equal(matcher(item.grants,item.need),item.allowed,JSON.stringify(item));});\n")
