const {items}=await agentsys('GET','library/sections/ai.providers/items');
const previous=context.event.widget?.id==='provider'?context.event.widget.value:context.widgets.provider;
const selected=items.some(item=>item.id===previous)?previous:items[0]?.id??'';
await node.widgets([{id:'provider',kind:'select',label:'Provider',value:selected,options:items.length?items.map(item=>({value:item.id,label:item.name})):[{value:'',label:'No providers in Library'}]}]);
// Refresh connected Model selectors even when their wire itself did not change.
const graph=await agentsys('GET','projects/'+context.project_id+'/workflow');
const queue=[{source:context.instance_id,port:'id'}],seen=new Set(),initializers=new Set();
while(queue.length){
  const point=queue.shift(),key=point.source+':'+point.port;if(seen.has(key))continue;seen.add(key);
  for(const edge of graph.edges.filter(e=>e.source===point.source&&e.source_port===point.port)){
    const target=graph.nodes.find(n=>n.id===edge.target);
    if(target?.node_type==='reroute'){queue.push({source:target.id,port:'out'});continue;}
    const model=graph.complex.find(c=>'complex:'+c.id===edge.target&&c.source?.resource_id==='plugin.ai.model');
    if(model&&edge.target_port==='provider'){
      const init=graph.nodes.find(n=>model.members.includes(n.id)&&n.config?.title==='Initialize model');
      if(init)initializers.add(init.id);
    }
  }
}
if(initializers.size)await agentsys('POST','projects/'+context.project_id+'/evaluate-node',{node_ids:[...initializers]});
