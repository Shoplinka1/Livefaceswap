/**
 * Delaunay.ts — Bowyer-Watson incremental Delaunay triangulation.
 *
 * Returns a list of triangles (each a triple of point indices) that form
 * the Delaunay triangulation of the input point set.  Used to build the
 * face mesh from 68 face landmarks + boundary points.
 */

export type Pt2 = { x: number; y: number };
export type Tri = [number, number, number];

interface CC { cx: number; cy: number; r2: number; }

/** Circumcircle of triangle (pts[i], pts[j], pts[k]).  r2 = radius². */
function circumcircle(pts: Pt2[], i: number, j: number, k: number): CC {
  const ax = pts[i].x, ay = pts[i].y;
  const bx = pts[j].x, by = pts[j].y;
  const cx = pts[k].x, cy = pts[k].y;
  const D = 2 * (ax * (by - cy) + bx * (cy - ay) + cx * (ay - by));
  if (Math.abs(D) < 1e-10) return { cx: 0, cy: 0, r2: Number.MAX_VALUE };
  const sx = ax * ax + ay * ay;
  const sy = bx * bx + by * by;
  const sz = cx * cx + cy * cy;
  const ux = (sx * (by - cy) + sy * (cy - ay) + sz * (ay - by)) / D;
  const uy = (sx * (cx - bx) + sy * (ax - cx) + sz * (bx - ax)) / D;
  return { cx: ux, cy: uy, r2: (ax - ux) ** 2 + (ay - uy) ** 2 };
}

/**
 * Triangulate a set of 2D points using the Bowyer-Watson algorithm.
 * Returns triangle index triples referencing the original `points` array.
 */
export function triangulate(points: Pt2[]): Tri[] {
  const n = points.length;
  if (n < 3) return [];

  // Bounding box
  let minX = points[0].x, maxX = minX, minY = points[0].y, maxY = minY;
  for (const p of points) {
    if (p.x < minX) minX = p.x; if (p.x > maxX) maxX = p.x;
    if (p.y < minY) minY = p.y; if (p.y > maxY) maxY = p.y;
  }
  const spread = Math.max(maxX - minX, maxY - minY) * 10 + 1;
  const mx = (minX + maxX) / 2, my = (minY + maxY) / 2;

  // Super-triangle (indices n, n+1, n+2) — encloses all input points
  const superPts: Pt2[] = [
    { x: mx - spread,   y: my - spread },
    { x: mx,            y: my + spread * 2 },
    { x: mx + spread,   y: my - spread },
  ];
  const allPts: Pt2[] = [...points, ...superPts];

  // Triangulation starts with the super-triangle
  let tris: Tri[] = [[n, n + 1, n + 2]];

  for (let pi = 0; pi < n; pi++) {
    const px = allPts[pi].x, py = allPts[pi].y;

    const bad: Tri[]  = [];
    const good: Tri[] = [];

    for (const t of tris) {
      const cc = circumcircle(allPts, t[0], t[1], t[2]);
      const dx = px - cc.cx, dy = py - cc.cy;
      // Slightly relaxed test (×1.0000001) handles collinear edge cases
      if (dx * dx + dy * dy < cc.r2 * 1.0000001) {
        bad.push(t);
      } else {
        good.push(t);
      }
    }

    // Boundary edges of the "bad" region (appear exactly once)
    const edgeCnt = new Map<string, number>();
    const edgeArr = new Map<string, [number, number]>();
    for (const t of bad) {
      const edges: [number, number][] = [[t[0], t[1]], [t[1], t[2]], [t[2], t[0]]];
      for (const [a, b] of edges) {
        const key = a < b ? `${a},${b}` : `${b},${a}`;
        edgeCnt.set(key, (edgeCnt.get(key) ?? 0) + 1);
        edgeArr.set(key, [a, b]);
      }
    }

    // Re-triangulate the hole by connecting each boundary edge to the new point
    tris = [...good];
    for (const [key, cnt] of edgeCnt) {
      if (cnt === 1) {
        const [a, b] = edgeArr.get(key)!;
        tris.push([pi, a, b]);
      }
    }
  }

  // Remove triangles that touch the super-triangle vertices
  return tris.filter(t => t[0] < n && t[1] < n && t[2] < n);
}
