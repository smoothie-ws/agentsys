const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
const run = new AsyncFunction('node', node.input.input);
node.output.result = await run(node);
await node.emit("out");