'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const root=path.resolve(__dirname,'..');
test('integration workspace contains no second active product implementation',()=>{
  for(const name of ['package.json','headless.js','server','shared','js','css','index.html','client','client-plugins','sdk','bin'])
    assert.equal(fs.existsSync(path.join(root,name)),false,name);
  for(const name of ['artifact-smoke.py','local.py']){
    const source=fs.readFileSync(path.join(root,'tools',name),'utf8');
    assert.doesNotMatch(source,/require\(['"]\.\.\/(?:server|headless|js)\//);
  }
});
