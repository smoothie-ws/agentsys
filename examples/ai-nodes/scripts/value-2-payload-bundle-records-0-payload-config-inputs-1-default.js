if(!node.resumed) await node.wait({approval:{question:node.input.question,timeout:node.input.timeout}});
node.output.result=node.resumed.value;
await node.emit("Out");