//! Line-of-sight raycasting / visibility-polygon engine.
//! This is a direct Rust port of the (bug-fixed) JS algorithm from the
//! prototype: for a point light at `origin`, sample angles at every wall
//! endpoint (plus tiny +/- epsilon offsets) and at every wall-wall
//! intersection, cast a ray at each angle, and keep the nearest hit. The
//! resulting points, sorted by angle, form the light's visibility polygon.

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Point {
    pub x: f64,
    pub y: f64,
}

#[derive(Clone, Copy, Debug)]
pub struct Wall {
    pub a: Point,
    pub b: Point,
}

struct Hit {
    x: f64,
    y: f64,
    dist: f64,
}

/// Ray (origin ox,oy direction dx,dy) vs segment (a..b). Returns the hit
/// point and distance along the ray, or None if the ray misses the segment
/// or the segment is "behind" the ray origin.
fn seg_intersect(
    ox: f64,
    oy: f64,
    dx: f64,
    dy: f64,
    ax: f64,
    ay: f64,
    bx: f64,
    by: f64,
) -> Option<Hit> {
    let sx = bx - ax;
    let sy = by - ay;
    let denom = dx * sy - dy * sx;
    if denom.abs() < 1e-9 {
        return None;
    }
    // t2 = position along the wall segment (0..1 inclusive is "on the wall")
    let t2 = (dy * (ax - ox) - dx * (ay - oy)) / denom;
    if t2 < 0.0 || t2 > 1.0 {
        return None;
    }
    let px = ax + sx * t2;
    let py = ay + sy * t2;
    // t1 = distance along the ray; derive from whichever axis is more stable
    let t1 = if dx.abs() > dy.abs() {
        (px - ox) / dx
    } else {
        (py - oy) / dy
    };
    if t1 < 0.001 {
        return None;
    }
    Some(Hit {
        x: px,
        y: py,
        dist: t1,
    })
}

/// Intersection point of two finite segments, if they actually cross.
fn seg_seg_intersect(p1: Point, p2: Point, p3: Point, p4: Point) -> Option<Point> {
    let d1x = p2.x - p1.x;
    let d1y = p2.y - p1.y;
    let d2x = p4.x - p3.x;
    let d2y = p4.y - p3.y;
    let denom = d1x * d2y - d1y * d2x;
    if denom.abs() < 1e-9 {
        return None;
    }
    let t = ((p3.x - p1.x) * d2y - (p3.y - p1.y) * d2x) / denom;
    let u = ((p3.x - p1.x) * d1y - (p3.y - p1.y) * d1x) / denom;
    if !(0.0..=1.0).contains(&t) || !(0.0..=1.0).contains(&u) {
        return None;
    }
    Some(Point {
        x: p1.x + d1x * t,
        y: p1.y + d1y * t,
    })
}

fn cast_ray(ox: f64, oy: f64, angle: f64, max_dist: f64, walls: &[Wall]) -> Point {
    let dx = angle.cos();
    let dy = angle.sin();
    let mut best = Hit {
        x: ox + dx * max_dist,
        y: oy + dy * max_dist,
        dist: max_dist,
    };
    for w in walls {
        if let Some(h) = seg_intersect(ox, oy, dx, dy, w.a.x, w.a.y, w.b.x, w.b.y) {
            if h.dist < best.dist {
                best = h;
            }
        }
    }
    Point {
        x: best.x,
        y: best.y,
    }
}

/// Every point where two walls cross. This is purely a function of the wall
/// set - it does not depend on any light's position - so when several
/// lights share the same wall list (the normal case: one `compute_visibility`
/// call per frame-update covering every lit token/torch), this should be
/// computed once and reused, not once per light. O(walls^2), same cost as
/// before, just no longer multiplied by the light count.
pub fn precompute_wall_intersections(walls: &[Wall]) -> Vec<Point> {
    let mut pts = Vec::new();
    for i in 0..walls.len() {
        for j in (i + 1)..walls.len() {
            if let Some(ip) = seg_seg_intersect(walls[i].a, walls[i].b, walls[j].a, walls[j].b) {
                pts.push(ip);
            }
        }
    }
    pts
}

/// Builds the full 360-degree visibility polygon for a point at (ox,oy),
/// clipped to `max_dist`, occluded by `walls`. Directional cones are
/// applied afterward by the caller (clipping this polygon to an angular
/// wedge is cheap and doesn't need re-raycasting). `wall_intersections`
/// should be `precompute_wall_intersections(walls)` - pass the same value
/// in for every light sharing this wall set rather than recomputing it.
pub fn visibility_polygon(
    ox: f64,
    oy: f64,
    max_dist: f64,
    walls: &[Wall],
    wall_intersections: &[Point],
    sample_count: usize,
) -> Vec<Point> {
    use std::collections::BTreeMap;
    // BTreeMap keyed on a quantized angle keeps the result sorted and de-duplicates
    // near-identical angles cheaply (same approach as the JS prototype's Set).
    let mut angles: BTreeMap<i64, f64> = BTreeMap::new();
    let quantize = |a: f64| (a * 1e7) as i64;
    let push = |a: f64, angles: &mut BTreeMap<i64, f64>| {
        angles.insert(quantize(a), a);
    };

    let sample_count = sample_count.clamp(24, 96);
    for i in 0..sample_count {
        let a =
            -std::f64::consts::PI + (2.0 * std::f64::consts::PI) * (i as f64 / sample_count as f64);
        push(a, &mut angles);
    }
    let eps = 0.0005;
    for w in walls {
        for p in [w.a, w.b] {
            let a = (p.y - oy).atan2(p.x - ox);
            push(a, &mut angles);
            push(a + eps, &mut angles);
            push(a - eps, &mut angles);
        }
    }
    for ip in wall_intersections {
        let a = (ip.y - oy).atan2(ip.x - ox);
        push(a, &mut angles);
        push(a + eps, &mut angles);
        push(a - eps, &mut angles);
    }

    angles
        .values()
        .map(|&a| cast_ray(ox, oy, a, max_dist, walls))
        .collect()
}

/// Clips a 360 visibility polygon's *angle range* down to a directional cone,
/// re-using the already-computed polygon rather than re-raycasting. This is
/// an approximation (it filters existing samples rather than inserting new
/// ones exactly at the cone edges), good enough since the frontend also adds
/// its own geometric wedge clip on top of whatever points we hand back.
pub fn clip_to_cone(poly: &[Point], ox: f64, oy: f64, facing: f64, cone_deg: f64) -> Vec<Point> {
    if cone_deg >= 359.5 {
        return poly.to_vec();
    }
    let half = (cone_deg.to_radians()) / 2.0;
    poly.iter()
        .cloned()
        .filter(|p| {
            let a = (p.y - oy).atan2(p.x - ox);
            let mut diff = a - facing;
            while diff > std::f64::consts::PI {
                diff -= 2.0 * std::f64::consts::PI;
            }
            while diff < -std::f64::consts::PI {
                diff += 2.0 * std::f64::consts::PI;
            }
            diff.abs() <= half + 0.01
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn wall_directly_ahead_blocks_the_ray() {
        // Regression test for the exact sign bug found in the JS prototype:
        // a vertical wall at x=2 spanning y=-1..1 must block a ray fired
        // straight along +x from the origin, hitting at (2,0).
        let hit = seg_intersect(0.0, 0.0, 1.0, 0.0, 2.0, -1.0, 2.0, 1.0);
        assert!(hit.is_some());
        let h = hit.unwrap();
        assert!((h.x - 2.0).abs() < 1e-9);
        assert!((h.y - 0.0).abs() < 1e-9);
        assert!((h.dist - 2.0).abs() < 1e-9);
    }

    #[test]
    fn visibility_polygon_is_bounded_by_wall() {
        let walls = [Wall {
            a: Point { x: 2.0, y: -5.0 },
            b: Point { x: 2.0, y: 5.0 },
        }];
        let wall_ix = precompute_wall_intersections(&walls);
        let poly = visibility_polygon(0.0, 0.0, 100.0, &walls, &wall_ix, 72);
        // Every point of the polygon in the +x direction should stop at x<=2 (the wall),
        // not escape to the full max_dist of 100.
        for p in &poly {
            if p.x > 0.0 && p.y.abs() < 4.0 {
                assert!(p.x <= 2.001, "point escaped past the wall: {:?}", p);
            }
        }
    }

    #[test]
    fn no_walls_reaches_max_dist() {
        let poly = visibility_polygon(0.0, 0.0, 50.0, &[], &[], 72);
        for p in &poly {
            let d = (p.x * p.x + p.y * p.y).sqrt();
            assert!((d - 50.0).abs() < 1e-6);
        }
    }

    #[test]
    fn shared_wall_intersections_match_per_light_recompute() {
        // Two crossing walls (the exact shape that needed the wall-wall
        // intersection fix in an earlier round). Two different light
        // origins sharing one precomputed intersection list must produce
        // the same polygons as if each had recomputed it independently.
        let walls = [
            Wall {
                a: Point { x: -3.0, y: -3.0 },
                b: Point { x: 3.0, y: 3.0 },
            },
            Wall {
                a: Point { x: -3.0, y: 3.0 },
                b: Point { x: 3.0, y: -3.0 },
            },
        ];
        let shared_ix = precompute_wall_intersections(&walls);
        assert_eq!(
            shared_ix.len(),
            1,
            "the two walls should cross exactly once"
        );

        for &(ox, oy) in &[(-10.0, 0.0), (10.0, 5.0), (0.0, -10.0)] {
            let via_shared = visibility_polygon(ox, oy, 50.0, &walls, &shared_ix, 72);
            let fresh_ix = precompute_wall_intersections(&walls);
            let via_fresh = visibility_polygon(ox, oy, 50.0, &walls, &fresh_ix, 72);
            assert_eq!(via_shared.len(), via_fresh.len());
            for (a, b) in via_shared.iter().zip(via_fresh.iter()) {
                assert!((a.x - b.x).abs() < 1e-9 && (a.y - b.y).abs() < 1e-9);
            }
        }
    }
}
