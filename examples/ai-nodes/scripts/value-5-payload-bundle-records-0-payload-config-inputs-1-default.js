const r=await agentsys("POST","llm",{prompt:node.input.prompt,schema:{type:"object",properties:{branch:{type:"string",enum:["Yes","No"]}},required:["branch"]}});
node.output.result=r.value.branch;
await node.emit(r.value.branch);