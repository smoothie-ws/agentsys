const {from, to, step} = node.input;
if (![from, to, step].every(Number.isFinite)) throw new Error('For: from, to and step are numbers');
if (step === 0) throw new Error('For: step cannot be 0');
for (let i = from; step > 0 ? i < to : i > to; i += step) {
  node.output.index = i;
  if ((await node.emit('body', {handles: ['break', 'continue']})) === 'break') break;
}
await node.emit('done');