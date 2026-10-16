export const SLOTS = 60;

type Point = readonly [number, number];

/** Values in [0, max] mapped into a box, newest on the right edge. */
export const points = (values: readonly number[], width: number, height: number, max = 100, slots = SLOTS): Point[] =>
  values.map((v, i) => [
    width - (values.length - 1 - i) * (width / (slots - 1)),
    height - (Math.min(Math.max(v, 0), max) / max) * height,
  ]);

const join = (pts: readonly Point[]) => pts.map(([x, y]) => `${+x.toFixed(1)},${+y.toFixed(1)}`).join(" ");

export const sparkline = (values: readonly number[], width: number, height: number, max = 100, slots = SLOTS) =>
  join(points(values, width, height, max, slots));

const xy = ([x, y]: Point) => `${+x.toFixed(1)},${+y.toFixed(1)}`;

/** An SVG path through the values as a smooth curve (Catmull-Rom turned into cubic Béziers). */
export const curve = (values: readonly number[], width: number, height: number, max = 100, slots = SLOTS): string => {
  const pts = points(values, width, height, max, slots);
  const [first] = pts;
  if (!first) return "";
  let d = `M${xy(first)}`;
  for (let i = 0; i < pts.length - 1; i++) {
    const [p0, p1, p2, p3] = [pts[i - 1] ?? pts[i], pts[i], pts[i + 1], pts[i + 2] ?? pts[i + 1]];
    if (!p0 || !p1 || !p2 || !p3) continue;
    const c1: Point = [p1[0] + (p2[0] - p0[0]) / 6, p1[1] + (p2[1] - p0[1]) / 6];
    const c2: Point = [p2[0] - (p3[0] - p1[0]) / 6, p2[1] - (p3[1] - p1[1]) / 6];
    d += ` C${xy(c1)} ${xy(c2)} ${xy(p2)}`;
  }
  return d;
};

/** The curve closed down to the baseline, for a filled area. */
export const curveArea = (values: readonly number[], width: number, height: number, max = 100, slots = SLOTS): string => {
  const pts = points(values, width, height, max, slots);
  const [first, last] = [pts[0], pts[pts.length - 1]];
  return first && last ? `${curve(values, width, height, max, slots)} L${xy([last[0], height])} L${xy([first[0], height])} Z` : "";
};

/** The sparkline closed down to the baseline, for a filled area. */
export const area = (values: readonly number[], width: number, height: number, max = 100, slots = SLOTS) => {
  const pts = points(values, width, height, max, slots);
  const first = pts[0];
  return first ? join([...pts, [width, height], [first[0], height]]) : "";
};
