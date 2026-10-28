const rows=[1,2,3];
node.output.result=rows.map(x=>x*2).reduce((sum,x)=>sum+x,0);
node.display(node.output.result);