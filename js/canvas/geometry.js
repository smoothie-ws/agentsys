// Pure wire geometry shared by rendering, selection hit tests and page previews.
'use strict';

/** The shape of a wire from output `a` to input `b`, as chosen in Settings → Appearance → Graph Editor. */
function wirePath(a, b, {wire_style: shape, wire_curve: curve}) {
  if (shape === 'linear') return `M${a.x},${a.y} L${b.x},${b.y}`;
  if (shape === 'step' || shape === 'rounded') return roundedPolyline(stepPoints(a, b), shape === 'rounded' ? 16 : 0);
  const dx = Math.max(40, Math.abs(b.x - a.x) * (curve / 100));
  return `M${a.x},${a.y} C${a.x + dx},${a.y} ${b.x - dx},${b.y} ${b.x},${b.y}`;
}

/** Corners of a stepped wire: it leaves the output and enters the input horizontally; when the target is behind, it detours through the middle height. */
function stepPoints(a, b) {
  const stub = 24,
    x1 = a.x + stub,
    x2 = b.x - stub;
  return x2 >= x1
    ? [a, {x: (a.x + b.x) / 2, y: a.y}, {x: (a.x + b.x) / 2, y: b.y}, b]
    : [a, {x: x1, y: a.y}, {x: x1, y: (a.y + b.y) / 2}, {x: x2, y: (a.y + b.y) / 2}, {x: x2, y: b.y}, b];
}

/** The corners (or, for a curve, samples) of the wire from `a` to `b`, in the shape it is drawn in. */
function edgePoints(a, b, {wire_style: shape, wire_curve: curve}, samples = 24) {
  if (shape === 'linear') return [a, b];
  if (shape === 'step' || shape === 'rounded') return stepPoints(a, b);
  const dx = Math.max(40, Math.abs(b.x - a.x) * (curve / 100)),
    points = [];
  for (let i = 0; i <= samples; i++) {
    const t = i / samples,
      u = 1 - t;
    points.push({
      x: u ** 3 * a.x + 3 * u * u * t * (a.x + dx) + 3 * u * t * t * (b.x - dx) + t ** 3 * b.x,
      y: u ** 3 * a.y + 3 * u * u * t * a.y + 3 * u * t * t * b.y + t ** 3 * b.y,
    });
  }
  return points;
}

/** A polyline whose corners are cut by up to `radius` (never more than half a segment) and rounded. */
function roundedPolyline(points, radius) {
  let d = `M${points[0].x},${points[0].y}`;
  for (let i = 1; i < points.length - 1; i++) {
    const [p, c, n] = [points[i - 1], points[i], points[i + 1]],
      back = Math.min(radius, Math.hypot(c.x - p.x, c.y - p.y) / 2),
      forward = Math.min(radius, Math.hypot(n.x - c.x, n.y - c.y) / 2),
      toward = (from, to, by) => {
        const length = Math.hypot(to.x - from.x, to.y - from.y) || 1;
        return `${from.x + ((to.x - from.x) / length) * by},${from.y + ((to.y - from.y) / length) * by}`;
      };
    d += ` L${toward(c, p, back)} Q${c.x},${c.y} ${toward(c, n, forward)}`;
  }
  const last = points[points.length - 1];
  return `${d} L${last.x},${last.y}`;
}
