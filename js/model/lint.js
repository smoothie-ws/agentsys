'use strict';

function lintGraph(snapshot) {
  const warnings = [];
  const scripts = snapshot.nodes.filter(n => n.config?.op === 'script');
  for (const n of scripts) {
    const code = n.config.inputs?.find(p => p.id === 'script')?.default ?? '';
    if (typeof code !== 'string') continue;
    const warn = (code, message) => warnings.push({node_id: n.id, code, message, severity: 'warning'});
    if (code.split('\n').length > 80)
      warn('long_script', 'This Script exceeds 80 lines; consider separating orchestration steps.');
    if (!n.config.capabilities?.length && !snapshot.complex.some(c => c.source && c.members.includes(n.id)))
      warn(
        'no_capabilities',
        'Script has no declared capabilities. Calls to the API will require a manifest and grants.'
      );
    if (
      /\b(?:while|for)\s*\(/.test(code) &&
      !/\b(?:max[_A-Za-z]*|limit|budget|Check budget)\b|<\s*\d+|\.length/.test(code)
    )
      warn('unbounded_loop', 'Loop has no visible bound or budget check.');
  }
  return {
    warnings,
    statistics: {
      script_count: scripts.length,
      script_lines: scripts.map(
        n => String(n.config.inputs?.find(p => p.id === 'script')?.default ?? '').split('\n').length
      ),
      library_nodes: snapshot.complex.filter(c => c.source).length,
      raw_scripts: scripts.filter(n => !snapshot.complex.some(c => c.source && c.members.includes(n.id))).length,
    },
    review_after: '2027-04-28',
  };
}
