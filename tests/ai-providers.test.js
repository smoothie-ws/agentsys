'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {createApp,fn}=require('./harness');
async function fixture(t, response){
  const app=createApp({scripts:'worker'}), requests=[];
  t.after(()=>app.Backend.shutdownPlugins());
  app.context.fetch=async(url, options)=>{
    requests.push({url:String(url),...options});
    const data=await response(String(url),options);
    return {status:data.status??200,text:async()=>JSON.stringify(data.body??data)};
  };
  await app.api('POST','plugins/builtin',{});
  await app.api('PUT','plugins/ai',{grants:['net.fetch:*']});
  const provider=await app.api('POST','library/sections/ai.providers/items',{
    name:'Local',values:{providerId:'local',baseURL:'http://provider.test/v1/',apiKey:'private-provider-key'}
  });
  const load=()=>app.api('POST','plugins/ai/call/models',{item_id:provider.id});
  return {app,provider,requests,load};
}
test('AI loads models with the saved key, normalizes and sorts IDs without exposing credentials',async t=>{
  const {app,provider,requests,load}=await fixture(t,()=>({data:[{id:'z'},{id:'a',name:'Alpha'},{id:'z'}]}));
  assert.deepEqual(await load(),{items:[{id:'a',label:'Alpha'},{id:'z',label:'z'}]});
  assert.equal(requests[0].url,'http://provider.test/v1/models');
  assert.equal(requests[0].headers.Authorization,'Bearer private-provider-key');
  const item=await app.api('GET','library/sections/ai.providers/items/'+provider.id);
  assert.equal(item.values.models,undefined);
  assert.ok(!JSON.stringify(item).includes('private-provider-key'));
  await app.api('PUT','plugins/ai',{grants:[]});
  await assert.rejects(load(),/permission/i);
  assert.equal(requests.length,1);
});
test('Anthropic models use API headers, honor overrides and load subsequent pages',async t=>{
  const {app,provider,requests,load}=await fixture(t,url=>url.includes('after_id=')
    ? {data:[{id:'b',display_name:'Beta'}],has_more:false}
    : {data:[{id:'a',display_name:'Alpha'}],has_more:true,last_id:'a'});
  await app.api('PUT','library/sections/ai.providers/items/'+provider.id,{values:{npm:'@ai-sdk/anthropic',headers:{'Anthropic-Version':'2023-06-01'}}});
  assert.deepEqual(await load(),{items:[{id:'a',label:'Alpha'},{id:'b',label:'Beta'}]});
  assert.equal(requests.length,2);
  assert.equal(requests[0].headers['x-api-key'],'private-provider-key');
  assert.equal(requests[0].headers['Anthropic-Version'],'2023-06-01');
  assert.equal(requests[0].headers['anthropic-version'],undefined);
  assert.equal(requests[1].url,'http://provider.test/v1/models?after_id=a');
});
test('model endpoint errors are reported, and reflected credentials are redacted',async t=>{
  let response={status:401,body:{error:'private-provider-key'}};
  const {load}=await fixture(t,()=>response);
  await assert.rejects(load(),error=>/HTTP 401/.test(error.message)&&!error.message.includes('private-provider-key'));
  response={body:{unexpected:true}};
  await assert.rejects(load(),/array/);
  response={body:{data:[{id:'private-provider-key',name:'private-provider-key'}]}};
  assert.deepEqual(await load(),{items:[{id:'[REDACTED]',label:'[REDACTED]'}]});
});
test('Script can read Library resources and JSON HTTP responses through the checked bridge',async t=>{
  const {app}=await fixture(t,()=>({hello:'world'}));
  const project=await app.api('POST','projects',{name:'Script API'});
  const script=await fn(app,project.id,{}, {capabilities:['library.read','net.fetch:provider.test'],outputs:['result'],code:`
    const {items}=await agentsys('GET','library/sections/ai.providers/items');
    const resources=await agentsys('GET','resources');
    const response=await agentsys('POST','net',{url:'http://provider.test/data'});
    if(response.status<200||response.status>=300)throw Error('HTTP '+response.status);
    node.output.result={provider:items[0].values.providerId,nodes:resources.length,data:JSON.parse(response.text)};
  `});
  const run=await app.api('POST',`projects/${project.id}/execution`,{node_ids:[script.id],wait:true});
  assert.equal(run.status,'completed',JSON.stringify(run.errors));
  assert.equal(run.outputs[script.id].result.provider,'local');
  assert.deepEqual(run.outputs[script.id].result.data,{hello:'world'});
});
