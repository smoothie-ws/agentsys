node.output.result=await agentsys("GET","initiatives/"+node.input.initiative+"/tasks",{});
await node.emit("Out");