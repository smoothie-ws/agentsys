const {initiative} = node.input;
const base="initiatives/"+node.input.initiative.id;
await agentsys("PUT",base+"/tasks/"+node.input.initiative.task,{version:1,status:"doing"});
await agentsys("PUT",base+"/tasks/"+node.input.initiative.task,{version:2,status:"done"});
await agentsys("POST",base+"/decisions",{summary:"Task completed",rationale:"Deterministic example",made_by:"controller"});
node.display("Task completed");