node.output.result=await agentsys("POST","initiatives/"+node.input.initiative+"/decisions",{summary:node.input.summary,rationale:node.input.rationale,made_by:"controller"});
await node.emit("Out");