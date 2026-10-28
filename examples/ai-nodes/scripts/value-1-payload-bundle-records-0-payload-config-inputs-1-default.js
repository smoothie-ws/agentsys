node.output.result=(await agentsys("POST","llm",{prompt:node.input.prompt,schema:node.input.schema})).value;
await node.emit("Out");