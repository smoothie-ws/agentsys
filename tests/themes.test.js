'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {createApp} = require('./harness');

const palette = {background:'#080808',surface:'#101010',text:'#ededed',accent:'#d9d9d9'};
const preset = (extra = {}) => ({id:'night-studio',name:'Ночная студия',style:{...palette,font_size:16,effects:true,animations:false,wire_style:'step',node_radius:12},...extra});

test('named themes and the selected theme persist in settings and session', async () => {
  const app = createApp();
  const theme = preset();
  await app.api('PUT','settings',{themes:[theme],theme:'saved:'+theme.id,style:theme.style});
  const settings = await app.api('GET','settings');
  const session = await app.api('GET','session');
  assert.deepEqual(settings.preferences.themes,[theme]);
  assert.deepEqual(session.preferences.themes,[theme]);
  assert.equal(session.preferences.theme,'saved:'+theme.id);
  await app.api('PUT','settings',{style:{accent:'#82aaff'}});
  const after = (await app.api('GET','settings')).preferences;
  assert.equal(after.style.accent,'#82aaff');
  assert.equal(after.themes[0].style.accent,palette.accent,'editing the active theme does not modify its saved preset');
});

test('theme validation rejects duplicate names and ids, malformed presets and unsupported styles atomically', async () => {
  const app = createApp();
  const good = preset();
  await app.api('PUT','settings',{themes:[good],style:palette});
  const before = (await app.api('GET','settings')).preferences;
  const invalid = [
    [good,preset({id:'other',name:good.name.toLocaleUpperCase()})],
    [good,preset({name:'Another'})],
    [preset({name:' '})],
    [preset({id:'bad:id'})],
    [preset({style:{background:'#080808'}})],
    [preset({style:{...palette,accent:'red'}})],
    [preset({style:{...palette,effects:'yes'}})],
    [preset({style:{...palette,font_size:100}})],
    [preset({style:{...palette,wire_style:'unknown'}})],
    [preset({style:{...palette,unknown:true}})],
    [preset({style:null})],
    Array.from({length:101},(_,i)=>preset({id:'id-'+i,name:'Theme '+i})),
  ];
  for (const themes of invalid) {
    await assert.rejects(app.api('PUT','settings',{style:{accent:'#82aaff'},themes}));
    assert.deepEqual((await app.api('GET','settings')).preferences,before,'failed imports leave settings and themes intact');
  }
});

test('restoring active settings keeps saved themes; saving a replacement preset retains its name and id', async () => {
  const app = createApp();
  const theme = preset();
  await app.api('PUT','settings',{themes:[theme]});
  const updated = {...theme,style:{...palette,accent:'#82aaff'}};
  await app.api('PUT','settings',{themes:[updated]});
  await app.api('PUT','settings',{style:palette,theme:'',shortcuts:{},undo_steps:50});
  assert.deepEqual((await app.api('GET','settings')).preferences.themes,[updated]);
});

test('component appearance persists alpha colours and zero radii in the active and saved theme', async () => {
  const app=createApp();
  const components={fields:{background:'#20304080',focus:'#304050cc',radius:0},buttons:{primary:'#ff8800',text:'#eeeeee'},panels:{sidebar:'#101010ee',radius:24},status:{success:'#76ffcc'}};
  const theme=preset({style:{...palette,components}});
  await app.api('PUT','settings',{style:theme.style,themes:[theme]});
  const prefs=(await app.api('GET','settings')).preferences;
  assert.deepEqual(prefs.style.components,components);
  assert.deepEqual(prefs.themes[0].style.components,components);
  await app.api('PUT','settings',{style:{components:{}}});
  assert.deepEqual((await app.api('GET','settings')).preferences.style.components,{});
  assert.deepEqual((await app.api('GET','settings')).preferences.themes[0].style.components,components);
});

test('component validation rejects unknown groups, unsafe values and invalid radii without changing settings', async () => {
  const app=createApp();
  await app.api('PUT','settings',{style:{...palette,components:{fields:{radius:8}}}});
  for (const components of [{unknown:{text:'#ffffff'}},{fields:{unknown:'#ffffff'}},{fields:{background:'url(x)'}},{fields:{background:'#fff'}},{fields:{radius:-1}},{fields:{radius:49}},{fields:{radius:0.5}},{fields:[]},[]]) {
    await assert.rejects(app.api('PUT','settings',{style:{components}}));
    assert.deepEqual((await app.api('GET','settings')).preferences.style.components,{fields:{radius:8}});
  }
});
