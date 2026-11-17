"""Platform-neutral discovery for integration tooling, with no product imports."""
from pathlib import Path
import json

def cli_path(package, product):
    metadata=json.loads((package/'package.json').read_text(encoding='utf-8'))
    return package/metadata['bin']['agentsys-'+product]

def npm_cli(node):
    directory=Path(node).resolve().parent
    candidates=[directory/'node_modules/npm/bin/npm-cli.js',directory.parent/'lib/node_modules/npm/bin/npm-cli.js']
    for candidate in candidates:
        if candidate.is_file():return candidate
    raise RuntimeError('Cannot find npm-cli.js beside the selected Node installation')
