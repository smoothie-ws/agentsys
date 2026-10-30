// Start, pause and stop the current workflow execution; transient node results stay on the canvas.
'use strict';
function syncToolbar(){
  if(!W.canvas?.isConnected || !$('#run-summary')) return;
  $('#run-summary').innerHTML=W.running ? '<span class="dot busy"></span>'+ (W.runPaused?'Paused':'Running') : '';
  const start=$('#start'); if(start){start.classList.toggle('stop',!!W.running);start.title=W.running?'Stop':'Run';start.innerHTML=icon(W.running?'stop':'play')+'<span>'+(W.running?'Stop':'Run')+'</span>';}
  const pause=$('#pause');if(pause){pause.hidden=!W.running;pause.title=pause.ariaLabel=W.runPaused?'Resume':'Pause';pause.innerHTML=icon(W.runPaused?'play':'pause');}
  $('#undo').disabled=!W.history.undo;$('#redo').disabled=!W.history.redo;
  W.canvas.classList.toggle('busy',!!W.running);W.canvas.closest('.editor')?.classList.toggle('running',!!W.running);
}
function syncComplexStatus() {
  const memo = new Map();
  const stateOf = id => {
    if (!id.startsWith('complex:')) return W.runStatus.get(id);
    if (memo.has(id)) return memo.get(id);
    memo.set(id, undefined); // a group inside itself is not possible; this only guards the recursion
    const states = (W.complex.get(id.slice('complex:'.length))?.members || []).map(stateOf);
    const state = ['running', 'blocked', 'failed', 'completed', 'skipped'].find(s => states.includes(s));
    memo.set(id, state);
    return state;
  };
  for (const cx of W.snapshot.complex) {
    const node = W.nodes.get('complex:' + cx.id);
    if (node) {
      node.status = stateOf(node.id) || 'ready';
    }
  }
}


function applyExecution(detail){
  W.running=['running','paused'].includes(detail.status);W.runPaused=detail.paused;W.executionId=detail.id;
  W.runStatus.clear();
  for(const item of detail.nodes??[]){
    if(W.running || ['failed','blocked'].includes(item.status)) W.runStatus.set(item.node_id,item.status==='working'?'running':item.status);
    if(item.error)W.results.set(item.node_id,{error:item.error});
  }
  for(const [id,text] of Object.entries(detail.displays??{}))W.results.set(id,{text});
  for(const node of W.nodes.values())node.status=W.runStatus.get(node.id)||'ready';
  syncComplexStatus();syncToolbar();draw();
}
async function followExecution(initial){
  const canvas=W.canvas, project=W.project, workflow=W.workflow, id=initial.id;
  applyExecution(initial);
  while(canvas===W.canvas && canvas.isConnected && W.executionId===id && W.running){
    await new Promise(resolve=>setTimeout(resolve,100));
    const detail=await api('projects/'+project+'/execution',{query:{workflow_id:workflow,id}});
    if(canvas!==W.canvas || !canvas.isConnected || W.executionId!==id) return;
    applyExecution(detail);
    if(detail.status==='failed')toast('Execution failed. See the errors on the canvas.',true);
  }
}
async function runAction(){
  if(W.running)return;
  await flushNodeEdits();await Inspector.leave();
  const canvas=W.canvas, epoch=++W.executionEpoch;
  W.executionId=null;
  W.results.clear();W.runStatus.clear();W.running=true;syncToolbar();
  try{
    W.startRequest=api('projects/'+W.project+'/execution',{method:'POST',body:wf({})});
    const detail=await W.startRequest;
    if(W.canvas===canvas && canvas.isConnected)await followExecution(detail);
  }finally{if(W.canvas===canvas && canvas.isConnected && W.executionEpoch===epoch){W.startRequest=null;W.running=false;W.runPaused=false;syncToolbar();}}
}
async function stopRun(){
  const canvas=W.canvas;
  const started=await W.startRequest;
  if(W.canvas!==canvas)return;
  const detail=await api('projects/'+W.project+'/execution',{method:'DELETE',query:{workflow_id:W.workflow,id:started?.id??W.executionId}});
  if(W.canvas===canvas)applyExecution(detail);
}
async function pauseRun(){
  const canvas=W.canvas;
  await W.startRequest;
  if(W.canvas!==canvas)return;
  const detail=await api('projects/'+W.project+'/execution/'+(W.runPaused?'resume':'pause'),{method:'POST',body:wf({id:W.executionId})});
  if(W.canvas===canvas)applyExecution(detail);
}
async function flushNodeEdits(){await W.flushInline?.();await Inspector.flushConnections?.();await Inspector.pending?.();}
