from pathlib import Path
import json
s=Path(__file__).resolve().parents[2]/'agentsys-server'
p=s/'api/openapi.json'; spec=json.loads(p.read_text())
string={'type':'string'}; obj={'type':'object'}
schemas={
 'Project':{'type':'object','required':['id','name'],'properties':{'id':string,'name':string,'description':string,'workflow_count':{'type':'integer','minimum':0}}},
 'Workflow':{'type':'object','required':['id','name'],'properties':{'id':string,'name':string,'description':string}},
 'LibraryResource':{'type':'object','required':['id','name','payload'],'properties':{'id':string,'name':string,'payload':obj}},
 'CollectionRecord':{'type':'object','required':['id','data','version'],'properties':{'id':string,'data':obj,'version':{'type':'integer','minimum':1}}},
 'Collection':{'type':'object','required':['name'],'properties':{'name':string,'title':string,'schema':obj}},
 'Permissions':{'type':'object','properties':{'allow':{'type':'array','items':string},'grants':{'type':'array','items':string}}},
 'Discovery':{'type':'object','required':['agentsys','product','version','protocol','api_version','features','auth'],'properties':{'agentsys':{'const':True},'product':{'const':'agentsys'},'version':string,'protocol':{'type':'integer'},'api_version':{'type':'string','pattern':'^[0-9]+\\.[0-9]+$'},'features':{'type':'object','additionalProperties':{'type':'boolean'}},'auth':{'enum':['token','loopback']},'server_name':string,'api':{'const':'/api'}}},
 'Session':{'type':'object','required':['ok','mode','expires_in'],'properties':{'ok':{'type':'boolean'},'mode':string,'expires_in':{'type':'integer'}}},
 'Execution':{'type':'object','properties':{'dispatch_status':string,'outputs':obj,'displays':obj,'errors':{'type':'array','items':{}}}},
}
spec['components']['schemas'].update(schemas)
spec['components']['schemas']['Event']['properties']['entry']=obj
for route,methods in spec['paths'].items():
 for method,operation in methods.items():
  if 'requestBody' in operation:
   for content in operation['requestBody']['content'].values(): content.setdefault('schema',{'type':'object'})
  schema=None
  if route=='/api/meta': schema={'$ref':'#/components/schemas/Discovery'}
  elif route=='/api/auth/session' and method=='post':schema={'$ref':'#/components/schemas/Session'}
  elif route=='/api/projects' and method=='get':schema={'type':'array','items':{'$ref':'#/components/schemas/Project'}}
  elif route=='/api/projects' and method=='post':schema={'$ref':'#/components/schemas/Project'}
  elif route=='/api/projects/{project_id}/workflow' and method=='get':schema={'$ref':'#/components/schemas/GraphDocument'}
  elif route=='/api/resources' and method=='get':schema={'type':'array','items':{'$ref':'#/components/schemas/LibraryResource'}}
  elif route=='/api/collections' and method=='get':schema={'type':'array','items':{'$ref':'#/components/schemas/Collection'}}
  if schema: operation['responses']['200']['content']={'application/json':{'schema':schema}}
for name,schema in spec['components']['schemas'].items():
 (s/f'api/schemas/{name}.json').write_text(json.dumps({'$schema':'https://json-schema.org/draft/2020-12/schema',**schema},indent=2)+'\n')
p.write_text(json.dumps(spec,indent=2)+'\n')
