'use strict';
const test = require('node:test'),
  assert = require('node:assert/strict');
const {createApp, fn, flow, nodes} = require('./harness');
async function setup(t) {
  const app = createApp({scripts: 'worker'}),
    p = await app.api('POST', 'projects', {name: 'Interpreter'});
  t.after(() => app.Backend.shutdownExecutions());
  return {app, id: p.id, path: `projects/${p.id}/execution`, make: options => fn(app, p.id, {}, options)};
}
async function connect(p, source, port, target) {
  await p.app.api('POST', `projects/${p.id}/port-connections`, {
    add: [{source, source_port: port, target: target.wrapper, target_port: 'in'}],
  });
}
test('manual completion emission is additional to automatic completion', async t => {
  const p = await setup(t),
    a = await p.make({code: 'await node.output.out.emit();context.state.after=true;', signals: ['out']}),
    b = await p.make({code: 'context.state.calls=(context.state.calls??0)+1;'});
  await connect(p, a.wrapper, 'out', b);
  const result = await p.app.api('POST', p.path, {node_ids: [a.id], wait: true});
  assert.equal(result.state.calls, 2);
  assert.equal(result.state.after, true);
});
test('an awaited named signal publishes values and joins its branches', async t => {
  const p = await setup(t),
    a = await p.make({
      code: 'node.output.value=42;context.state.order=[];await node.output.body.emit();context.state.order.push("joined");',
      outputs: ['value'],
      signals: ['body'],
    }),
    b = await p.make({
      code: 'await node.sleep(20);context.state.order.push("branch");node.display(node.input.value);',
      inputs: ['value'],
    });
  await connect(p, a.wrapper, 'body', b);
  await p.app.api('POST', `projects/${p.id}/port-connections`, {
    add: [{source: a.wrapper, source_port: 'value', target: b.wrapper, target_port: 'value'}],
  });
  const result = await p.app.api('POST', p.path, {node_ids: [a.id], wait: true});
  assert.deepEqual(result.state.order, ['branch', 'joined']);
  assert.equal(result.displays[b.id], '42');
});
test('failed Script does not emit automatic out', async t => {
  const p = await setup(t),
    a = await p.make({code: 'throw Error("failure");', signals: ['out']}),
    b = await p.make({code: 'context.state.reached=true;'});
  await connect(p, a.wrapper, 'out', b);
  const result = await p.app.api('POST', p.path, {node_ids: [a.id], wait: true});
  assert.equal(result.state.reached, undefined);
  assert.match(result.errors[a.id], /failure/);
});
test('an emission handling break ends a loop without its completion branch', async t => {
  const p = await setup(t),
    a = await p.make({
      code: 'context.state.steps=0;for(let i=0;i<10;i++){context.state.steps++;if(await node.output.body.emit({handles:["break"]})==="break")break;}context.state.finished=true;',
      signals: ['body'],
    }),
    b = await p.make({code: 'node.flow.break();', signals: ['out']}),
    c = await p.make({code: 'context.state.unreachable=true;'});
  await connect(p, a.wrapper, 'body', b);
  await connect(p, b.wrapper, 'out', c);
  const result = await p.app.api('POST', p.path, {node_ids: [a.id], wait: true});
  assert.equal(result.state.steps, 1);
  assert.equal(result.state.finished, true);
  assert.equal(result.state.unreachable, undefined);
  assert.deepEqual(result.errors, {});
});
test('JSON values crossing node boundaries are copies', async t => {
  const p = await setup(t),
    a = await p.make({
      code: 'node.output.value={x:1};await node.output.body.emit();node.display(node.output.value.x);',
      outputs: ['value'],
      signals: ['body'],
    }),
    b = await p.make({code: 'node.input.value.x=2;', inputs: ['value']});
  await connect(p, a.wrapper, 'body', b);
  await p.app.api('POST', `projects/${p.id}/port-connections`, {
    add: [{source: a.wrapper, source_port: 'value', target: b.wrapper, target_port: 'value'}],
  });
  const result = await p.app.api('POST', p.path, {node_ids: [a.id], wait: true});
  assert.equal(result.displays[a.id], '1');
});
test('a loop can emit more than one thousand signals without a chain limit', async t => {
  const p = await setup(t),
    a = await p.make({
      code: 'context.state.calls=0;for(let i=0;i<1100;i++)await node.output.body.emit();',
      signals: ['body'],
    }),
    b = await p.make({code: 'context.state.calls++;'});
  await connect(p, a.wrapper, 'body', b);
  const result = await p.app.api('POST', p.path, {node_ids: [a.id], wait: true});
  assert.equal(result.state.calls, 1100);
  assert.deepEqual(result.errors, {});
});

test('the interpreter follows a chain deeper than one thousand nodes', async () => {
  const app = createApp();
  const result = await app.eval(`(async()=>{
    const count=1200,outputs=[{id:'out',name:'out',type:'signal'}];
    const graph={diagnostics:[],complex:[],groups:[],widgets:{},types:[],
      nodes:Array.from({length:count},(_,i)=>({id:'n'+i,kind:'function',node_type:'custom',config:{op:'script',outputs},
        inputs:[{id:'in',name:'in',type:'signal'},{id:'script',name:'script',default:'context.state.count=(context.state.count??0)+1;'}],outputs})),
      edges:Array.from({length:count-1},(_,i)=>({source:'n'+i,source_port:'out',target:'n'+(i+1),target_port:'in'}))};
    let state={},errors=[];
    const interpreter=createGraphInterpreter(graph,{}, {AsyncFunction:Object.getPrototypeOf(async function(){}).constructor,
      displayText,call:()=>{throw Error('Unexpected API call');},context:{},
      emit:event=>{if(event.ev==='state')state=event.state;if(event.error)errors.push(event.error);}});
    await interpreter.signal(['n0']);return {state,errors};
  })()`);
  assert.equal(result.state.count, 1200);
  assert.equal(result.errors.length, 0);
});
