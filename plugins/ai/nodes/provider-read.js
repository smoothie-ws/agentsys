const {items}=await agentsys('GET','library/sections/ai.providers/items');
const item=items.find(item=>item.id===context.widgets.provider);
node.output.id=item?.values.providerId??null;
node.output.url=item?.values.baseURL??null;
