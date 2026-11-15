'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {analyze} = require('../client-plugins/graph-developer-tools/analyze');

test('graph tools finds disconnected nodes, invalid links and Custom Node references', () => {
  const graph = {nodes: [{id: 'event'}, {id: 'alone'}, {id: 'inner-script'}], complex: [{id: 'wrapper', source: {resource_id: 'lib1'},
    interface: {inputs: [{id: 'in', bound: [{node_id: 'inner-script', port_id: 'in'}]}]}}],
    edges: [{source: 'event', target: 'complex:wrapper'}, {source: 'missing', target: 'event'}]};
  const report = analyze(graph);
  assert.deepEqual(report.disconnected, ['alone']);
  assert.equal(report.errors.length, 1);
  assert.deepEqual(report.customNodes, [{id: 'wrapper', resource: 'lib1'}]);
});
