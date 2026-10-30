'use strict';
const sections=require('./collections.json');
const {createService}=require('./service');
exports.activate=function(context){
  const {app}=context, service=createService(app);
  const group=app.library.registerSection(sections[0]);
  const providers=app.library.registerCollection({...sections[1],parent:group});
  const models=app.endpoints.register('models',request=>service.models(request.body),{permissions:['library.read']});
  const prepare=app.endpoints.register('prepare-request',request=>service.prepare(request.body),{permissions:['library.read']});
  const request=app.endpoints.register('request',request=>service.request(request.body),{permissions:['net.fetch:{host}'],timeout:120000});
  const nodes=app.library.registerNodeCatalog('nodes/catalog.json');
  context.subscriptions.add(group,providers,models,prepare,request,nodes);
};
