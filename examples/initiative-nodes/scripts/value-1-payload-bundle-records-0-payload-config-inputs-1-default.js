node.output.result=await agentsys("POST","initiatives/"+node.input.initiative+"/tasks",{title:node.input.title,depends_on:node.input.depends_on});
await node.emit("Out");