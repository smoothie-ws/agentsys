const list = node.input.list;
if (!Array.isArray(list)) throw new Error('For each: list is a list');
for (let i = 0; i < list.length; i++) {
  node.output.item = list[i];
  node.output.index = i;
  if ((await node.output.body.emit({handles: ['break', 'continue']})) === 'break') break;
}
await node.output.done.emit();
