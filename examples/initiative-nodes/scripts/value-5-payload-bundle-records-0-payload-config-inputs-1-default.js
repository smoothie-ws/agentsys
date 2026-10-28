node.output.result=await agentsys("POST","initiatives/"+node.input.initiative+"/facts",{text:node.input.text,source:node.input.source,confidence:node.input.confidence});
await node.emit("Out");