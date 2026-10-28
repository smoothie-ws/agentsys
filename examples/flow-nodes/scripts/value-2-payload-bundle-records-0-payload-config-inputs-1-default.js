const max = node.input.max;
let passes = 0;
while (await node.reread('condition')) {
  if (++passes > max) throw new Error('While: more than ' + max + ' passes');
  if ((await node.emit('body', {handles: ['break', 'continue']})) === 'break') break;
}
await node.emit('done');