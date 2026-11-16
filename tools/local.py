"""One-command integration launcher for two independently packaged products."""
from pathlib import Path
import argparse, os, shutil, subprocess

root=Path(__file__).resolve().parents[1]
parser=argparse.ArgumentParser()
parser.add_argument('--server-artifact',type=Path,required=True)
parser.add_argument('--client-artifact',type=Path,required=True)
parser.add_argument('--server-port',type=int,default=8080)
parser.add_argument('--client-port',type=int,default=8081)
parser.add_argument('--data',type=Path,default=root/'.local/data')
args=parser.parse_args()
node=shutil.which('node'); npm=Path(node).parent/'node_modules/npm/bin/npm-cli.js'
children=[]
try:
    for product,archive in [('server',args.server_artifact),('client',args.client_artifact)]:
        archive=archive.resolve(strict=True)
        target=root/'.local/packages'/product
        target.mkdir(parents=True,exist_ok=True)
        subprocess.run([node,str(npm),'install','--prefix',str(target),'--ignore-scripts','--no-audit','--no-fund',str(archive)],check=True)
    client_url=f'http://127.0.0.1:{args.client_port}'
    server_url=f'http://127.0.0.1:{args.server_port}'
    commands=[('server',['start','--port',str(args.server_port),'--data',str(args.data.resolve()),'--allowed-origin',client_url]),('client',['serve','--port',str(args.client_port),'--server',server_url])]
    for product,flags in commands:
        cli=root/'.local/packages'/product/'node_modules'/('agentsys-'+product)/'bin'/('agentsys-'+product+'.js')
        children.append(subprocess.Popen([node,str(cli),*flags]))
    print('Client: '+client_url+' | Server: '+server_url,flush=True)
    while all(child.poll() is None for child in children):
        try: children[0].wait(timeout=1)
        except subprocess.TimeoutExpired: pass
except KeyboardInterrupt:
    pass
finally:
    for child in children:
        if child.poll() is None: child.terminate()
    for child in children:
        try: child.wait(timeout=10)
        except subprocess.TimeoutExpired: child.kill(); child.wait()
