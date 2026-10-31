'use strict';
const fs=require('node:fs'),path=require('node:path');
const TEXT='t:64428b9c654c2c2cfcb55742ea899ed8',CODE='t:a42dbde0c1e1090d6adf1640c2dda533',NUMBER='t:fbe54fdd1dd24d55a0ec083cc057017e';
const request=JSON.parse(fs.readFileSync(path.join(__dirname,'request.json'),'utf8'));
const types=request.payload.bundle.types;
const read=file=>fs.readFileSync(path.join(__dirname,file+'.js'),'utf8');
const signal=(id,name=id)=>({id,name,type:'signal'}),text=(id,name=id)=>({id,name,type:TEXT});
function graph(name,key,inputs,outputs,grants){
  const group='ai-'+key;
  return {name,payload:{icon:{Provider:'server',Model:'spark',Ask:'message'}[name]??'code',description:{Provider:'Choose a Provider from the AI Library.',Model:'Choose a model available from the connected Provider.',Ask:'Send a text prompt through Request and return the model text.'}[name]??'',grants,bundle:{version:3,source_project:'lib-plugin.ai.'+key,types:JSON.parse(JSON.stringify(types)),records:[],groups:[{id:group,name,parent:null,members:[]}],complex:[{id:group,interface:{inputs,outputs},collapsed:false,compact_width:260,compact_height:100,arbitrary:{inputs:false,outputs:false}}],port_edges:[],styles:{},widgets:{},positions:{}}}};
}
function node(entry,key,title,op,code,widgets){
  const b=entry.payload.bundle,id='record:'+key;
  const config={title,op,inputs:op==='script'?[signal('in'),{id:'script',name:'script',type:CODE,default:read(code)}]:[],outputs:[signal('out')],...(widgets?{widgets}: {})};
  b.records.push({id,payload:{kind:'function',node_type:'custom',label:'Custom',status:'ready',config}});b.groups[0].members.push(id);b.positions[id]={x:b.records.length*260,y:40};
  const out=b.complex[0].interface.outputs.find(port=>port.name==='out'&&port.type==='signal');
  if(op==='script'&&out&&!out.bound)bind(out,id,'out');
  return id;
}
function wire(entry,source,source_port,target,target_port){const b=entry.payload.bundle;b.port_edges.push({id:'wire-'+b.port_edges.length,source,source_port,target,target_port});}
function bind(port,node_id,port_id){port.bound=[{node_id,port_id}];return port;}
function merge(entry,child,groupId,source){
  const b=entry.payload.bundle,c=JSON.parse(JSON.stringify(child.payload.bundle)),root=c.groups.find(g=>!g.parent),cx=c.complex.find(g=>g.id===root.id);
  root.parent=groupId;if(source){cx.source=source;cx.grants=['net.fetch:*'];}
  for(const key of ['records','groups','complex','port_edges'])b[key].push(...c[key]);
  Object.assign(b.positions,c.positions);Object.assign(b.styles,c.styles);Object.assign(b.widgets,c.widgets);
  return {id:'complex:'+root.id,interface:cx.interface};
}
const provider=graph('Provider','provider',[],[text('id'),text('url')],['graph.read','graph.write','library.read','run.start']);
const pi=node(provider,'ai-provider-init','Initialize provider','script','provider-init',[{id:'provider',kind:'select',label:'Provider',value:'',options:[{value:'',label:'Loading providers…'}]}]);
for(const event of ['on_placed','on_widget'])wire(provider,node(provider,'ai-provider-'+event,event,event),'out',pi,'in');
const pr=node(provider,'ai-provider-read','Read provider','script','provider-read');wire(provider,node(provider,'ai-provider-on_read','on_read','on_read'),'out',pr,'in');
const model=graph('Model','model',[text('provider')],[text('model')],['graph.read','graph.write','library.read']);
const mi=node(model,'ai-model-init','Initialize model','script','model-init',[{id:'model',kind:'select',label:'Model',value:'',options:[{value:'',label:'Connect a Provider'}]}]);
for(const event of ['on_placed','on_input_connected'])wire(model,node(model,'ai-model-'+event,event,event),'out',mi,'in');
const mr=node(model,'ai-model-read','Read model','script','model-read');wire(model,node(model,'ai-model-on_read','on_read','on_read'),'out',mr,'in');
const ask=graph('Ask','ask',[signal('in'),text('url'),text('model'),text('prompt'),text('provider')],[signal('out'),text('response')],['library.read','net.fetch:*']);
const prepare=graph('Prepare request','prepare-request',[signal('in'),text('url'),text('model'),text('prompt'),text('provider')],[signal('out'),{id:'request',name:'request'}],[]);
const ps=node(prepare,'ai-ask-prepare','Prepare request','script','ask-prepare');bind(prepare.payload.bundle.complex[0].interface.inputs[0],ps,'in');
const parse=graph('Read response','read-response',[signal('in'),{id:'status',name:'status',type:NUMBER},text('response')],[signal('out'),text('response')],[]);
const rs=node(parse,'ai-ask-response','Read response','script','ask-response');bind(parse.payload.bundle.complex[0].interface.inputs[0],rs,'in');
const root=ask.payload.bundle.groups[0].id;
const a=merge(ask,prepare,root),r=merge(ask,request,root,{resource_id:request.id,stamp:request.updated}),z=merge(ask,parse,root);
const rq=r.interface.inputs.find(p=>p.name==='request'),endpoint=r.interface.inputs.find(p=>p.name==='endpoint');endpoint.default='plugins/ai/call/request';
const askInterface=ask.payload.bundle.complex[0].interface;
for(const port of askInterface.inputs)bind(port,a.id,port.id);
bind(askInterface.outputs[0],z.id,'out');bind(askInterface.outputs[1],z.id,'response');
wire(ask,a.id,'out',r.id,r.interface.inputs.find(p=>p.name==='in').id);wire(ask,a.id,'request',r.id,rq.id);
wire(ask,r.id,r.interface.outputs.find(p=>p.name==='out').id,z.id,'in');
for(const name of ['status','response'])wire(ask,r.id,r.interface.outputs.find(p=>p.name===name).id,z.id,name);
const TextGraph=require('../../../js/storage/format');
fs.writeFileSync(path.join(__dirname,'catalog.json'),JSON.stringify(TextGraph.encode([provider,model,ask]),null,2)+'\n');
