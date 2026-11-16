"""Exercise patch-only product upgrades using synthetic artifacts, never source imports."""
from pathlib import Path
import json, os, shutil, subprocess, tarfile, tempfile

root=Path(__file__).resolve().parents[1]
from integration_common import npm_cli
node=shutil.which('node'); npm=npm_cli(node)
work=Path(tempfile.mkdtemp(prefix='agentsys-update-matrix-'))

def variant(product,original,version,major=None):
    stage=work/(product+'-'+version); stage.mkdir()
    archive=Path(os.environ.get('AGENTSYS_'+product.upper()+'_ARTIFACT') or root.parent/('agentsys-'+product)/f'agentsys-{product}-{original}.tgz')
    with tarfile.open(archive) as bundle: bundle.extractall(stage,filter='data')
    package=stage/'package'; metadata=package/'package.json'; value=json.loads(metadata.read_text()); value['version']=version; value.get('scripts',{}).pop('prepack',None); metadata.write_text(json.dumps(value))
    protocol=package/('runtime/protocol.js' if product=='server' else 'dist/client/js/app/protocol.js')
    text=protocol.read_text().replace("const VERSION = '"+original+"';","const VERSION = '"+version+"';")
    if major: text=text.replace('const PROTOCOL = 2;',f'const PROTOCOL = {major};').replace("const API_VERSION = '2.0';",f"const API_VERSION = '{major}.0';")
    protocol.write_text(text)
    subprocess.run([node,str(npm),'pack','--ignore-scripts','--pack-destination',str(work)],cwd=package,check=True,capture_output=True)
    return work/f'agentsys-{product}-{version}.tgz'

client=variant('client','0.7.0','0.7.1')
server=variant('server','0.4.0','0.4.1')
incompatible=variant('server','0.4.0','3.0.0',3)
report={'synthetic':True,'work':str(work),'runs':[]}
for name,server_archive,client_archive in [('client-only',None,client),('server-only',server,None),('both',server,client)]:
    env=dict(os.environ,AGENTSYS_INCOMPATIBLE_SERVER_ARTIFACT=str(incompatible))
    if server_archive:env['AGENTSYS_SERVER_ARTIFACT']=str(server_archive)
    if client_archive:env['AGENTSYS_CLIENT_ARTIFACT']=str(client_archive)
    result=subprocess.run([shutil.which('python'),'tools/artifact-smoke.py'],cwd=root,env=env,capture_output=True,text=True)
    (work/(name+'.log')).write_text(result.stdout+result.stderr,encoding='utf-8')
    print(name,result.returncode,flush=True)
    report['runs'].append({'name':name,'exit_code':result.returncode,'evidence':result.stdout.split('Evidence: ')[-1].strip()})
    if result.returncode: print(result.stdout+result.stderr); break
(root/'integration-results/independent-updates.json').write_text(json.dumps(report,indent=2)+'\n')
assert len(report['runs'])==3 and all(item['exit_code']==0 for item in report['runs'])
