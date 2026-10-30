const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
const run = new AsyncFunction('node', 'agentsys', 'context', 'Date', 'Math', '"use strict";\n' + (node.input.script ?? ''));
node.output.result = await run(node, agentsys, context, Date, Math);
await node.emit("out");
