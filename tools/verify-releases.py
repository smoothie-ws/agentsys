"""Download public GitHub release artifacts and verify independently shipped contents."""
from pathlib import Path
import hashlib, json, os, re, shutil, subprocess, tarfile, tempfile, urllib.request, zipfile

root=Path(__file__).resolve().parents[1]
target=Path(os.environ.get('AGENTSYS_RELEASE_DIRECTORY') or tempfile.mkdtemp(prefix='agentsys-releases-'))
target.mkdir(parents=True,exist_ok=True)
print('Verifying release downloads in '+str(target),flush=True)
report={'download_directory':str(target),'products':{}}
for product,version in [('server','0.1.0'),('client','0.1.0')]:
    repo='smoothie-ws/agentsys-'+product
    request=urllib.request.Request('https://api.github.com/repos/'+repo+'/releases/tags/v'+version,headers={'Accept':'application/vnd.github+json','User-Agent':'AgentSys-release-audit'})
    with urllib.request.urlopen(request,timeout=30) as response:release=json.load(response)
    assert not release['draft'] and not release['prerelease']
    record={'url':release['html_url'],'tag':release['tag_name'],'assets':[]}
    for asset in release['assets']:
        destination=target/asset['name']
        digest=hashlib.sha256()
        if destination.is_file() and destination.stat().st_size==asset['size']:
            with destination.open('rb') as downloaded:
                while chunk:=downloaded.read(1024*1024):digest.update(chunk)
        elif destination.name.endswith('image.tar.gz'):
            # Bound the entire transfer, rather than only each socket read.
            curl=shutil.which('curl.exe' if os.name=='nt' else 'curl')
            subprocess.run([curl,'--fail','--location','--continue-at','-','--max-time','1200','--retry','1','--output',str(destination),asset['browser_download_url']],check=True,timeout=2500)
            with destination.open('rb') as downloaded:
                while chunk:=downloaded.read(1024*1024):digest.update(chunk)
        else:
            with urllib.request.urlopen(asset['browser_download_url'],timeout=60) as response, destination.open('wb') as output:
                while chunk:=response.read(1024*1024):output.write(chunk);digest.update(chunk)
        assert destination.stat().st_size==asset['size']
        if asset.get('digest'):assert asset['digest']=='sha256:'+digest.hexdigest()
        record['assets'].append({'name':asset['name'],'bytes':asset['size'],'sha256':digest.hexdigest(),'url':asset['browser_download_url']})
        if destination.suffix=='.tgz':
            with tarfile.open(destination) as archive:
                names=archive.getnames(); metadata=json.load(archive.extractfile('package/package.json'))
                if metadata['name']=='agentsys-'+product:
                    assert metadata['version']==version
                    if product=='server':
                        assert not any(name.startswith(('package/js/','package/css/','package/client-plugins/')) or name=='package/index.html' for name in names)
                        for name in names:
                            if name.startswith('package/runtime/') and name.endswith('.js'):
                                source=archive.extractfile(name).read().decode('utf-8')
                                assert not re.search(r'\b(?:document|window)\.(?:createElement|querySelector|addEventListener|localStorage)\b',source),name
                    else:assert not any(name.startswith(('package/server/','package/runtime/','package/data/','package/tests/')) for name in names)
                else:
                    assert metadata['name']=='@agentsys/plugin-sdk'
                    assert set(names)=={'package/package.json','package/README.md','package/agentsys-plugin.d.ts'}
        if destination.suffix=='.zip':
            with zipfile.ZipFile(destination) as archive:
                names=archive.namelist()
                if product=='client':
                    assert 'index.html' in names and 'config.json' in names
                    assert not any(name.startswith(('server/','runtime/','tests/','data/','tools/','bin/')) for name in names)
                    assert json.loads(archive.read('config.json'))=={'defaultServerURL':''}
                    for name in names:
                        if name.startswith('js/') and name.endswith('.js') and name not in ['js/app/environments.js','js/app/config.js','js/app/plugin-store.js']:
                            assert not re.search(r'\bfetch\s*\(|\bXMLHttpRequest\b',archive.read(name).decode('utf-8')),name
                else:
                    assert 'openapi.json' in names
                    assert json.loads(archive.read('openapi.json'))['info']['version']=='1.0'
        if destination.name.endswith('image.tar.gz'):
            with tarfile.open(destination) as archive:assert any(name in archive.getnames() for name in ['manifest.json','index.json'])
    expected=({f'agentsys-server-{version}.tgz','agentsys-api-1.0.zip','agentsys-server-image.tar.gz'} if product=='server' else {f'agentsys-client-{version}.tgz','agentsys-client-static.zip','agentsys-plugin-sdk-0.1.0.tgz'})
    assert {asset['name'] for asset in record['assets']}==expected
    if product=='server':
        with zipfile.ZipFile(target/'agentsys-api-1.0.zip') as specification, tarfile.open(target/f'agentsys-server-{version}.tgz') as package:
            assert json.loads(specification.read('openapi.json'))==json.load(package.extractfile('package/api/openapi.json'))
    else:
        with zipfile.ZipFile(target/'agentsys-client-static.zip') as distribution, tarfile.open(target/f'agentsys-client-{version}.tgz') as package:
            public_files=set(json.load(package.extractfile('package/client/public-files.json')))
            assert {name for name in distribution.namelist() if not name.endswith('/')}==public_files
    report['products'][product]=record
    print('PASS verified published '+product+' artifacts',flush=True)
(root/'integration-results/releases.json').write_text(json.dumps(report,indent=2)+'\n')
print('Release artifacts: '+str(target))
