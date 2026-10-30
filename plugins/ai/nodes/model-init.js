const provider=node.input.provider;
const previous=context.widgets.model;
let result={items:[]};
if(provider){
  await node.widgets([{id:'model',kind:'select',label:'Model',value:'',options:[{value:'',label:'Loading models…'}]}]);
  try{result=await agentsys('POST','plugins/ai/call/models',{provider});}
  catch(error){
    await node.widgets([{id:'model',kind:'select',label:'Model',value:'',options:[{value:'',label:'Models unavailable'}]}]);
    throw error;
  }
}
const selected=result.items.some(item=>item.id===previous)?previous:result.items[0]?.id??'';
await node.widgets([{id:'model',kind:'select',label:'Model',value:selected,options:result.items.length?result.items.map(item=>({value:item.id,label:item.label})):[{value:'',label:provider?'No models available':'Connect a Provider'}]}]);
