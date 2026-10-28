if (!node.resumed) await node.wait({event:node.input.event, match:node.input.match});
node.output.result=node.resumed.value;
await node.emit("Out");