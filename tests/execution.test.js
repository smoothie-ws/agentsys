'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {createApp, fn, nodes} = require('./harness');
const sleep = ms => new Promise(resolve=>setTimeout(resolve,ms));
async function fixture(code) {
  const app = createApp({scripts:'worker'}), project = await app.api('POST','projects',{name:'Execution'});
  const node = await fn(app,project.id,{}, {code,outputs:['result']});
  return {app,project,node,path:`projects/${project.id}/execution`};
}
async function settled(app,path) {
  for(let i=0;i<100;i++){const current=await app.api('GET',path);if(!['running','paused'].includes(current.status))return current;await sleep(10);}
  assert.fail('Execution did not finish');
}
test('start, execute and finish once; no history, triggers or recovery API',async()=>{
  const {app,node,path}=await fixture('node.output.result=21*2;');
  const result=await app.api('POST',path,{node_ids:[node.id],wait:true});
  assert.equal(result.status,'completed');assert.equal(result.outputs[node.id].result,42);
  assert.equal((await app.api('GET',path)).id,result.id);
  const next=await app.api('POST',path,{node_ids:[node.id],wait:true});assert.notEqual(next.id,result.id);
  const paths=Object.keys(app.Backend.openapi().paths);
  assert.ok(!paths.some(path=>/runs|triggers|scheduler|events\/|versions|queues|\/state/.test(path)));
});

test('Run accepts an empty graph or a graph without active start events and finishes with no work',async()=>{
  const app=createApp({scripts:'worker'}), project=await app.api('POST','projects',{name:'No active flow'});
  const path=`projects/${project.id}/execution`;
  const empty=await app.api('POST',path,{wait:true});
  assert.equal(empty.status,'completed');assert.equal(empty.evaluated_nodes,0);
  assert.equal(app.workerStats.started,0,'an empty execution needs no Worker');
  await fn(app,project.id,{}, {code:'throw Error("An unsignalled Script must not execute");',outputs:[]});
  const noEvent=await app.api('POST',path,{wait:true});
  assert.equal(noEvent.status,'completed');assert.deepEqual(noEvent.errors,{});assert.deepEqual(noEvent.nodes,[]);
  const event=await app.api('POST',`projects/${project.id}/primitives`,{primitive:'event',point:{x:0,y:0}});
  await app.api('PUT',`projects/${project.id}/node-style`,{node_id:event.id,disabled:true});
  const disabled=await app.api('POST',path,{wait:true});
  assert.equal(disabled.status,'completed');assert.equal(disabled.evaluated_nodes,0);
  const explicit=await app.api('POST',path,{node_ids:[],wait:true});
  assert.equal(explicit.status,'completed');assert.deepEqual(explicit.outputs,{});
});

test('late pause/resume/stop requests return the current state of an idle or finished graph',async()=>{
  const {app,node,path}=await fixture('node.output.result=42;');
  for(const action of ['pause','resume'])assert.equal((await app.api('POST',path+'/'+action,{})).status,'idle');
  assert.equal((await app.api('DELETE',path)).status,'idle');
  const finished=await app.api('POST',path,{node_ids:[node.id],wait:true});
  for(const action of ['pause','resume']){
    const current=await app.api('POST',path+'/'+action,{});
    assert.equal(current.status,'completed');assert.equal(current.id,finished.id);assert.equal(current.paused,false);
  }
  assert.equal((await app.api('DELETE',path)).status,'completed');
});

test('all graph start events run even when there are more than 200',async()=>{
  const app=createApp({scripts:'worker'}), project=await app.api('POST','projects',{name:'Many starts'});
  for(let i=0;i<201;i++)await app.api('POST',`projects/${project.id}/primitives`,{primitive:'event',point:{x:i*10,y:0}});
  const result=await app.api('POST',`projects/${project.id}/execution`,{wait:true});
  assert.equal(result.status,'completed');assert.equal(result.evaluated_nodes,201);
});

test('independent workflows are not blocked by a global admission quota',async()=>{
  const app=createApp({scripts:'worker'}), project=await app.api('POST','projects',{name:'Independent flows'});
  const workflows=[];
  try{
    for(let i=0;i<17;i++){
      const workflow=await app.api('POST',`projects/${project.id}/workflows`,{name:'Flow '+i});
      const node=await app.api('POST',`projects/${project.id}/typed-nodes`,{workflow_id:workflow.id,node_type:'custom',config:nodes.script('await node.sleep(60000);')});
      workflows.push(workflow.id);
      const started=await app.api('POST',`projects/${project.id}/execution`,{workflow_id:workflow.id,node_ids:[node.id]});
      assert.equal(started.status,'running');
    }
    for(const workflow_id of workflows)assert.equal((await app.api('GET',`projects/${project.id}/execution`,{}, {workflow_id})).status,'running');
  }finally{
    await app.Backend.shutdownExecutions();
  }
});
test('a Delay stays active, pause gates continuation and resume finishes without restarting code',async()=>{
  const {app,node,path}=await fixture('await node.sleep(150);node.output.result="done";');
  const first=await app.api('POST',path,{node_ids:[node.id]});
  assert.equal(first.status,'running');
  await assert.rejects(app.api('POST',path,{node_ids:[node.id]}),/already executing/);
  await app.api('POST',path+'/pause',{});await sleep(250);
  const paused=await app.api('GET',path);assert.equal(paused.status,'paused');assert.equal(paused.outputs[node.id],undefined);
  await app.api('POST',path+'/resume',{});
  const result=await settled(app,path);assert.equal(result.status,'completed');assert.equal(result.outputs[node.id].result,'done');
});
test('stop terminates the Worker and a fresh start has independent state',async()=>{
  const {app,node,path}=await fixture('await node.sleep(500);node.output.result="late";');
  await app.api('POST',path,{node_ids:[node.id]});
  const stopped=await app.api('DELETE',path);assert.equal(stopped.status,'stopped');
  await sleep(30);assert.equal((await app.api('GET',path)).outputs[node.id],undefined);
  assert.ok(app.workerStats.terminated>0);
  const result=await app.api('POST',path,{node_ids:[node.id],wait:true});assert.equal(result.status,'completed');
});
test('graph edits apply to the next execution; a script failure does not automatically retry',async()=>{
  const {app,project,node,path}=await fixture('await node.sleep(120);node.output.result="original";');
  await app.api('POST',path,{node_ids:[node.id]});
  const graph=await app.api('GET',`projects/${project.id}/workflow`);
  const config=graph.nodes.find(n=>n.id===node.id).config;
  config.inputs.find(p=>p.id==='script').default='node.output.result="edited";';
  await app.api('PUT',`projects/${project.id}/typed-nodes/${node.id}`,{node_type:'custom',config});
  assert.equal((await settled(app,path)).outputs[node.id].result,'original');
  assert.equal((await app.api('POST',path,{node_ids:[node.id],wait:true})).outputs[node.id].result,'edited');
  config.inputs.find(p=>p.id==='script').default='throw Error("one failure");';
  await app.api('PUT',`projects/${project.id}/typed-nodes/${node.id}`,{node_type:'custom',config});
  const failed=await app.api('POST',path,{node_ids:[node.id],wait:true});assert.equal(failed.status,'failed');
  await sleep(30);assert.equal((await app.api('GET',path)).id,failed.id);
});

test('Stop also cancels a nested graph evaluation started by a Script',async()=>{
  const {app,project,node,path}=await fixture('');
  const child=await fn(app,project.id,{}, {code:'await node.sleep(5000);',outputs:[]});
  const snapshot=await app.api('GET',`projects/${project.id}/workflow`);
  const config=snapshot.nodes.find(n=>n.id===node.id).config;
  config.inputs.find(p=>p.id==='script').default=`await agentsys('POST','projects/${project.id}/evaluate-node',{node_ids:['${child.id}'],collect:true});`;
  await app.api('PUT',`projects/${project.id}/typed-nodes/${node.id}`,{node_type:'custom',config});
  await app.api('POST',path,{node_ids:[node.id]});
  for(let i=0;i<100 && app.workerStats.started<2;i++)await sleep(10);
  assert.equal(app.workerStats.started,2);
  await app.api('DELETE',path);
  for(let i=0;i<100 && app.workerStats.terminated<2;i++)await sleep(10);
  assert.equal(app.workerStats.terminated,2);
});
