'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const context = vm.createContext({}); // No DOM, workflow or global appearance state.
vm.runInContext(fs.readFileSync(path.join(__dirname, '../js/canvas/geometry.js'), 'utf8'), context);
const {wirePath, edgePoints} = context;

test('wire rendering and hit testing preserve endpoints for every style, including backward and zero-length wires', () => {
  for (const wire_style of ['linear', 'step', 'rounded', 'bezier'])
    for (const b of [{x: 300, y: -40}, {x: -200, y: 90}, {x: 0, y: 0}]) {
      const a = {x: 0, y: 0}, style = {wire_style, wire_curve: 50};
      const drawn = wirePath(a, b, style), points = edgePoints(a, b, style);
      assert.match(drawn, /^M0,0/);
      assert.doesNotMatch(drawn, /NaN|Infinity/);
      assert.deepEqual([points[0].x, points[0].y], [a.x, a.y]);
      assert.deepEqual([points.at(-1).x, points.at(-1).y], [b.x, b.y]);
      assert.ok(points.every(p => Number.isFinite(p.x) && Number.isFinite(p.y)));
    }
});

test('wire curvature is supplied by its caller and does not leak between views', () => {
  const a = {x: 0, y: 0}, b = {x: 500, y: 50};
  const low = {wire_style: 'bezier', wire_curve: 10};
  const high = {wire_style: 'bezier', wire_curve: 100};
  const original = wirePath(a, b, low);
  assert.notEqual(wirePath(a, b, high), original);
  assert.equal(wirePath(a, b, low), original);
});
