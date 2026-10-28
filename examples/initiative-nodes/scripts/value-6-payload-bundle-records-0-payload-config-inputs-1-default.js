node.output.result=await agentsys("GET","initiatives/"+node.input.initiative+"/facts",{});
await node.emit("Out");