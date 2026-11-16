from pathlib import Path
import subprocess,json,shutil,re
source=Path.cwd().resolve()
server=source.parent/'agentsys-server';client=source.parent/'agentsys-client'
for target in [server,client]:
 assert target.resolve().parent==source.parent and target.name in ['agentsys-server','agentsys-client']
 subprocess.run(['git','remote','remove','origin'],cwd=target,check=True)
 subprocess.run(['git','branch','-m','main'],cwd=target,check=True)
 subprocess.run(['git','tag','migration/source-5f916bf','5f916bf24bea3a10a0566c68992f1eacb79a999a'],cwd=target,check=True)
manifest=re.findall(r"  '([^']+)'",(source/'server/manifest.js').read_text())
client_assets=json.loads((source/'client/public-files.json').read_text(encoding='utf-8-sig'))
client_tests=[];server_tests=[]
for p in (source/'tests').glob('*.test.js'):
 s=p.read_text(encoding='utf-8-sig')
 if any(t in s for t in ['../headless','./harness','../server/api-server','../server/file-store','../server/credentials']):
  if not any(t in s for t in ['index.html','js/app/','js/pages/','js/canvas/','../bin/agentsys-local','./client-harness','server/static-assets']):server_tests.append('tests/'+p.name)
 elif any(t in s for t in ['js/app/','js/pages/','js/canvas/','sdk/','client-plugins/','./client-harness','../client/build','../shared/protocol','index.html']):
  if not any(t in s for t in ['../server/','../headless','./harness','bin/agentsys-local']):client_tests.append('tests/'+p.name)
server_keep=set(manifest+['headless.js','bin/agentsys-server.js','shared/protocol.js','tests/harness.js','tools/stress.js','tools/soak.js','tools/backup.js']+server_tests)
server_keep.update('server/'+p.name for p in (source/'server').glob('*.js') if p.name!='static-assets.js')
client_keep=set(client_assets+['bin/agentsys-client.js','client/build.js','client/public-files.json','client/static-assets.js','tests/client-harness.js','tools/plugin-pack.js','tools/build-client-plugins.js']+client_tests)
client_keep.update(p.relative_to(source).as_posix() for d in ['sdk','docs'] for p in (source/d).rglob('*') if p.is_file() and 'separation' not in p.name.lower())
for target,keep,product,version in [(server,server_keep,'server','0.4.0'),(client,client_keep,'client','0.7.0')]:
 tracked=subprocess.check_output(['git','ls-files'],cwd=target,text=True).splitlines()
 for name in tracked:
  if name not in keep:
   p=target/name
   if p.exists():p.unlink()
 # Remove empty directories only, never recursively remove computed paths.
 for p in sorted(target.rglob('*'),key=lambda x:len(x.parts),reverse=True):
  if '.git' not in p.parts and p.is_dir() and not any(p.iterdir()):p.rmdir()
 (target/'.gitignore').write_text('node_modules/\ndist/\ndata/\n__pycache__/\n')
 package={'name':'agentsys-'+product,'version':version,'description':'Independent AgentSys '+product,'license':'UNLICENSED','bin':{'agentsys-'+product:'bin/agentsys-'+product+'.js'},'engines':{'node':'>=22'},'scripts':{'test':'node --test','start':'node bin/agentsys-'+product+'.js'+(' start' if product=='server' else '')},'files':(['bin/','server/','runtime/','headless.js','api/'] if product=='server' else ['bin/','client/','dist/client/'])}
 if product=='client':package['scripts'].update({'build':'node client/build.js','prepack':'node client/build.js'})
 (target/'package.json').write_text(json.dumps(package,indent=2)+'\n')
 # Own executable implementations: no external or shared path remains.
 mappings=({'shared/core':'runtime/core','shared/protocol':'runtime/protocol','js/storage/':'runtime/storage/','js/model/':'runtime/model/','js/backend/':'runtime/backend/'} if product=='server' else {'shared/core':'js/app/core','shared/protocol':'js/app/protocol'})
 for old,new in mappings.items():
  oldpath=target/old;newpath=target/new
  if oldpath.exists():newpath.parent.mkdir(parents=True,exist_ok=True);oldpath.rename(newpath)
  elif (target/(old+'.js')).exists():
   newpath=target/(new+'.js');newpath.parent.mkdir(parents=True,exist_ok=True);(target/(old+'.js')).rename(newpath)
 for p in target.rglob('*'):
  if '.git' in p.parts or not p.is_file() or p.suffix not in ['.js','.json','.html','.md','.py']:continue
  try:s=p.read_text(encoding='utf-8-sig')
  except UnicodeDecodeError:continue
  for old,new in mappings.items():s=s.replace(old,new)
  p.write_text(s,encoding='utf-8')
 protocol=target/('runtime/protocol.js' if product=='server' else 'js/app/protocol.js')
 s=protocol.read_text().replace("const VERSION = '0.3.0';",f"const VERSION = '{version}';\n  const API_VERSION = '2.0';").replace('    VERSION,','    VERSION,\n    API_VERSION,')
 protocol.write_text(s)
 (target/'MIGRATION.md').write_text('Source: smoothie-ws/agentsys at 5f916bf24bea3a10a0566c68992f1eacb79a999a.\nFull ancestry retained; migration/source-5f916bf tags the original source.\nThis repository owns its implementation and has no cross-repository runtime dependency.\n')
 subprocess.run(['git','add','-A'],cwd=target,check=True)
 subprocess.run(['git','commit','-m','refactor: extract independent '+product+' product and own runtime files'],cwd=target,check=True,stdout=subprocess.DEVNULL)
 print(product,len(keep),'files;',len(server_tests if product=='server' else client_tests),'test files')
