const i=await agentsys("POST","initiatives",{title:"Example delivery",goal:"Deliver one reviewed task"});
const task=await agentsys("POST","initiatives/"+i.id+"/tasks",{title:"Review delivery"});
node.output.initiative={id:i.id,task:task.id};
await node.emit("Out");