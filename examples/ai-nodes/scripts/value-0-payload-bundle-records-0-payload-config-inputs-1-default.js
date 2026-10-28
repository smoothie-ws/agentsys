node.output.result=await agentsys("POST","llm",{prompt:node.input.prompt,provider:node.input.provider,model:node.input.model});
await node.emit("Out");