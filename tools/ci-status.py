import json, os, subprocess, urllib.request
from pathlib import Path
from urllib.parse import quote
env=dict(os.environ,GIT_TERMINAL_PROMPT='0',GCM_INTERACTIVE='never')
result=subprocess.run(['git','credential','fill'],input='protocol=https\nhost=github.com\n\n',text=True,capture_output=True,env=env,timeout=20)
token=dict(line.split('=',1) for line in result.stdout.splitlines() if '=' in line).get('password')
assert token, 'No GitHub credential'
def get(route):
    req=urllib.request.Request('https://api.github.com'+route,headers={'Authorization':'Bearer '+token,'Accept':'application/vnd.github+json','User-Agent':'AgentSys-CI-audit'})
    with urllib.request.urlopen(req,timeout=30) as response:return json.load(response)
report={}
for product in ['server','client','integration']:
    repo='smoothie-ws/agentsys' if product=='integration' else 'smoothie-ws/agentsys-'+product
    ref=os.environ.get('AGENTSYS_CI_REF', 'main')
    sha=get('/repos/'+repo+'/commits/'+quote(ref, safe=''))['sha']
    runs=[run for run in get('/repos/'+repo+'/actions/runs?per_page=20')['workflow_runs'] if run['head_sha']==sha]
    report[product]=[]
    for run in runs:
        jobs=get('/repos/'+repo+'/actions/runs/'+str(run['id'])+'/jobs')['jobs']
        entry={'id':run['id'],'sha':run['head_sha'],'status':run['status'],'conclusion':run['conclusion'],'url':run['html_url'],'jobs':[{'name':j['name'],'status':j['status'],'conclusion':j['conclusion'],'id':j['id']} for j in jobs]}
        report[product].append(entry)
        print(product,entry['id'],entry['status'],entry['conclusion'])
        for job in entry['jobs']:print(' ',job['name'],job['status'],job['conclusion'])
Path('integration-results/ci-status.json').write_text(json.dumps(report,indent=2)+'\n')
