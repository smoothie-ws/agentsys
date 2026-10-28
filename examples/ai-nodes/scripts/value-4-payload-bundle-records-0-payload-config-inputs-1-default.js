node.output.result=(await agentsys("POST","llm",{prompt:"Compress the context, preserving decisions and unresolved work:\n"+node.input.context})).text;
await node.emit("Out");