while (await node.reread('condition')) {
  if ((await node.output.body.emit({handles: ['break', 'continue']})) === 'break') break;
}
await node.output.done.emit();
