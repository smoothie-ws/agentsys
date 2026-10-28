node.output.result=await agentsys("POST","initiatives",{title:node.input.title,goal:node.input.goal});
await node.emit("Out");