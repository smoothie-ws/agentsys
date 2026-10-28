node.output.result=await agentsys("PUT","initiatives/"+node.input.initiative+"/tasks/"+node.input.task,{version:node.input.version,status:node.input.status});
await node.emit("Out");