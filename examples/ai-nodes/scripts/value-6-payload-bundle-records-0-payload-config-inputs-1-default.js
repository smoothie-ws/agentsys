const messages=[{role:"user",content:node.input.prompt}];
for(let step=0;step<node.input.max_steps;step++){
  const response=await agentsys("POST","llm",{messages,schema:{type:"object",properties:{done:{type:"boolean"},text:{type:"string"},tool:{type:"string"},args:{type:"object"}},required:["done","text"]}});
  const action=response.value;node.output.result=action.text;
  if(action.done)break;
  const tool=(node.input.tools??[]).find(t=>t.name===action.tool);
  if(!tool)throw new Error("Unknown tool: "+action.tool);
  const result=await agentsys(tool.method,tool.path,action.args);
  messages.push({role:"assistant",content:response.text},{role:"user",content:JSON.stringify(result)});
}
await node.emit("Out");