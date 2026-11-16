'use strict';
const fs = require('node:fs'), path = require('node:path');
const base = path.resolve(__dirname, '../..');
const server = path.join(base, 'agentsys-server'), client = path.join(base, 'agentsys-client');
const Format = require(path.join(server, 'runtime/storage/format'));
const document = {cursor: 0, nodes: [], groups: [], complex: [], port_edges: [], types: [], layout: {}, widgets: {}, library_nodes: []};
const value = {document, packet: Format.encode(document)};
for (const [root, module] of [[server, '../runtime/storage/format'], [client, '../js/storage/format']]) {
  fs.writeFileSync(path.join(root, 'contract-fixtures/graph.json'), JSON.stringify(value, null, 2) + '\n');
  fs.writeFileSync(path.join(root, 'tests/format-contract.test.js'), `const test=require('node:test'),assert=require('node:assert/strict');
const Format=require('${module}'), fixture=require('../contract-fixtures/graph.json');
test('public graph document and text packet conform to published fixture',()=>{
assert.deepEqual(Format.encode(fixture.document),fixture.packet);
assert.deepEqual(Format.decode(fixture.packet),fixture.document);
});\n`);
  const product = root === server ? 'server' : 'client';
  fs.writeFileSync(path.join(root, 'tests/product-boundary.test.js'), `'use strict';
const test=require('node:test'), assert=require('node:assert/strict'), fs=require('node:fs'),path=require('node:path');
const root=path.resolve(__dirname,'..');
test('product source has no sibling repository or shared runtime dependency',()=>{
assert.equal(fs.existsSync(path.join(root,'shared')),false);
const metadata=require('../package.json');
assert.equal(metadata.workspaces,undefined);
for(const dependency of Object.values(metadata.dependencies||{})) assert.doesNotMatch(dependency,/^(?:file:|link:|workspace:)/);
function walk(dir){ for(const entry of fs.readdirSync(dir,{withFileTypes:true})){
if(['.git','node_modules','dist','tests','tools','data'].includes(entry.name)) continue;
const file=path.join(dir,entry.name);
assert.equal(entry.isSymbolicLink(),false,file);
if(entry.isDirectory()) walk(file);
else if(entry.name.endsWith('.js')){
const source=fs.readFileSync(file,'utf8');
for(const match of source.matchAll(/require\\(\\s*['"]([^'"]+)['"]\\s*\\)/g)){
const request=match[1]; if(!request.startsWith('.'))continue;
const target=path.resolve(path.dirname(file),request),relative=path.relative(root,target);
assert.ok(relative!=='..'&&!relative.startsWith('..'+path.sep)&&!path.isAbsolute(relative),file+' -> '+request);
assert.ok([target,target+'.js',target+'.json',path.join(target,'index.js')].some(p=>fs.existsSync(p)),file+' -> '+request);
}
}
}} walk(root);
});
test('distribution ownership excludes the other product implementation',()=>{
${product === 'server' ? "for(const name of ['index.html','css','js/app','client-plugins','sdk','client']) assert.equal(fs.existsSync(path.join(root,name)),false,name);\nfor(const file of require('../server/manifest').FILES) assert.ok(file.startsWith('runtime/'),file);" : "for(const name of ['server','runtime','headless.js','js/backend','js/storage/db.js','js/model/executor.js']) assert.equal(fs.existsSync(path.join(root,name)),false,name);\nfor(const file of require('../client/public-files.json')) assert.doesNotMatch(file,/^(?:server|runtime|tests|data|tools|bin)\\//);"}
});\n`);
}
