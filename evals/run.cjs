'use strict';
// Deliberately manual: quality evals do not run in node --test or block deterministic CI.
const fs = require('node:fs'),
  path = require('node:path');
(async () => {
  const base = process.env.AGENTSYS_EVAL_URL;
  if (!base) throw Error('Set AGENTSYS_EVAL_URL to a running AgentSys server with an explicitly configured provider.');
  const results = [];
  for (const item of require('./cases.json')) {
    const started = Date.now();
    const response = await fetch(base.replace(/\/$/, '') + '/api/llm', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-AgentSys': '1',
        ...(process.env.AGENTSYS_TOKEN ? {Authorization: 'Bearer ' + process.env.AGENTSYS_TOKEN} : {}),
      },
      body: JSON.stringify({
        prompt: item.prompt,
        provider: process.env.AGENTSYS_EVAL_PROVIDER,
        model: process.env.AGENTSYS_EVAL_MODEL,
      }),
    });
    const value = await response.json();
    if (!response.ok) throw Error(value.message ?? value.error);
    let pass =
      (item.contains ?? []).every(word => value.text.toLowerCase().includes(word)) &&
      (!item.max_chars || value.text.length <= item.max_chars);
    if (item.json_array_length)
      try {
        const parsed = JSON.parse(value.text);
        pass &&= Array.isArray(parsed) && parsed.length === item.json_array_length;
      } catch {
        pass = false;
      }
    results.push({name: item.name, pass, ms: Date.now() - started, text: value.text});
  }
  const report = {
    at: new Date().toISOString(),
    pass_rate: results.filter(r => r.pass).length / results.length,
    results,
  };
  fs.writeFileSync(path.join(__dirname, 'latest.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report, null, 2));
})().catch(e => {
  console.error(e.message);
  process.exitCode = 1;
});
