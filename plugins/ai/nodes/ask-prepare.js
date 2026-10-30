node.output.request=await agentsys('POST','plugins/ai/call/prepare-request',{
  provider:node.input.provider,url:node.input.url,model:node.input.model,prompt:node.input.prompt
});
await node.emit('out');
