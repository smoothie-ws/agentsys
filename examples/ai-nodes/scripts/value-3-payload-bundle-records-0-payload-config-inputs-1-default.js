node.output.result=await agentsys("GET","runs/"+context.run_id+"/budget");
await node.emit("Out");