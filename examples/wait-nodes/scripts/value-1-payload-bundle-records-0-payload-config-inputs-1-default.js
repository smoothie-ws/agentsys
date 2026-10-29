if (!node.resumed) await node.wait({delay:node.input.ms});
node.output.result=node.resumed.value;
await node.emit("out");