node.input.condition ? await node.output.if_true.emit() : await node.output.if_false.emit();
