#!/usr/bin/env python3
"""Render target application .MESHWORLD levels to PNG/GIF using only Pillow + numpy
(no GPU, no matplotlib). The game renders black under Wine/llvmpipe, so this is
the only way to visually inspect level geometry straight from the data.

v2 (2026-08): software z-buffer + perspective-correct UV texturing + lambert
shading from S5 vertex normals + REAL game textures from Textures/.
v1 used painter's-algorithm sorting with flat colors and was rejected by users
("super glitchy and has no textures") — do NOT regress to flat-color painter
rendering; the z-buffer is what removes the sorting artifacts.

Subcommands:
  single  <file.MESHWORLD> --out out.png [--yaw DEG] [--pitch DEG] [--size N]
          One render. yaw=0,pitch=0 -> top-down; yaw=45,pitch=35 -> isometric.
  orbit   <file.MESHWORLD> --out out.gif [--frames N] [--pitch DEG] [--size N]
          Rotating-camera GIF (camera orbits in yaw, fixed pitch).
  overlay <file.MESHWORLD> --map map.png --out out.png [--size N]
          Draw S1 ref-point markers (START/SAFESPOT/FLAG/BADBALL/SECRET/...)
          on a top-down render of the same file.
  atlas   <levels_dir> --outdir OUT [--overlay]
          Render every *.MESHWORLD in a directory (top-down, + overlays).
  stats   <file.MESHWORLD>
          Print vertex/geom/ref-point counts (quick sanity check).

Textures: auto-detected at <file dir>/Textures (or --texdir), real game textures
with bmp/png/tga fallback, case-insensitive. Material texture names INCLUDE the
extension (e.g. "goal.png") — strip it before trying extension fallbacks or every
texture reports MISSING. The famous checkers are 2x2 pixel textures tiled via UV.

Requires meshworld_parser.py on sys.path (use --parser-dir to point at the
the target-meshworld skill scripts/ dir, default: same dir as this file).
See game-reverse-engineering references/meshworld-software-rendering.md for
design notes + pitfalls.
"""
import argparse, math, os, sys
import numpy as np
from PIL import Image, ImageDraw

BG = (24, 26, 34)
_LIGHT = np.array([0.45, 0.85, 0.55], np.float64)
_LIGHT /= np.linalg.norm(_LIGHT)
_AMBIENT = 0.42

_tex_cache = {}
_tex_index = None


def load_parser(parser_dir=None):
    """Import meshworld_parser from the the target-meshworld skill scripts dir."""
    candidates = [parser_dir, os.path.dirname(os.path.abspath(__file__)),
                  '/home/evan/.hermes/skills/reverse-engineering/the target-meshworld/scripts']
    for c in candidates:
        if c and os.path.isdir(c):
            sys.path.insert(0, c)
    from meshworld_parser import MeshWorldFile  # noqa
    return MeshWorldFile


def tex_index(path):
    """Case-insensitive filename index for a textures dir (built once)."""
    global _tex_index
    if _tex_index is None:
        _tex_index = {}
        try:
            for f in os.listdir(path):
                _tex_index[f.lower()] = f
        except OSError:
            pass
    return _tex_index


def load_tex(name, texdir):
    """Load texture by name (WITH or WITHOUT extension). float32 RGBA or None."""
    if not name:
        return None
    if name in _tex_cache:
        return _tex_cache[name]
    if _tex_index is None:
        tex_index(texdir)
    base = name.rsplit('.', 1)[0] if '.' in name else name  # strip ext FIRST
    arr = None
    for ext in ('.bmp', '.png', '.tga'):
        fn = _tex_index.get((base + ext).lower())
        if fn is None:
            continue
        try:
            im = Image.open(os.path.join(texdir, fn))
            arr = np.array(im.convert('RGBA')).astype(np.float32) / 255.0
        except Exception:
            arr = None
        if arr is not None:
            break
    _tex_cache[name] = arr
    return arr


def checker_tex(diffuse, size=32):
    """Procedural checker in material diffuse color (fallback for missing tex)."""
    a = np.zeros((size, size, 4), np.float32)
    for y in range(size):
        for x in range(size):
            c = 0.75 if ((x // 4 + y // 4) % 2 == 0) else 0.35
            a[y, x] = [diffuse[0] * c, diffuse[1] * c, diffuse[2] * c, 1.0]
    return a


class Raster:
    """Software z-buffer triangle rasterizer (edge functions + barycentric lerp)."""

    def __init__(self, W, H, bg=BG):
        self.W, self.H = W, H
        self.bg = np.array(bg, np.float64) / 255.0
        self.img = np.full((H, W, 3), self.bg, np.float32)
        self.zbuf = np.full((H, W), np.inf, np.float32)

    def draw(self, X, Y, D, U, V, R, G, B, tex):
        area2 = (X[1] - X[0]) * (Y[2] - Y[0]) - (X[2] - X[0]) * (Y[1] - Y[0])
        if abs(area2) < 1e-9:
            return
        if area2 < 0:  # normalize winding to CCW
            X, Y, D = X[[0, 2, 1]], Y[[0, 2, 1]], D[[0, 2, 1]]
            U, V = U[[0, 2, 1]], V[[0, 2, 1]]
            R, G, B = R[[0, 2, 1]], G[[0, 2, 1]], B[[0, 2, 1]]
            area2 = -area2
        xmin = max(0, int(np.floor(X.min()))); xmax = min(self.W - 1, int(np.ceil(X.max())))
        ymin = max(0, int(np.floor(Y.min()))); ymax = min(self.H - 1, int(np.ceil(Y.max())))
        if xmax < xmin or ymax < ymin:
            return
        xs, ys = np.meshgrid(np.arange(xmin, xmax + 1, dtype=np.float32),
                             np.arange(ymin, ymax + 1, dtype=np.float32))
        e0 = (X[1] - X[0]) * (ys - Y[0]) - (Y[1] - Y[0]) * (xs - X[0])
        e1 = (X[2] - X[1]) * (ys - Y[1]) - (Y[2] - Y[1]) * (xs - X[1])
        e2 = (X[0] - X[2]) * (ys - Y[2]) - (Y[0] - Y[2]) * (xs - X[2])
        w0, w1, w2 = e0 / area2, e1 / area2, e2 / area2
        inside = (w0 >= 0) & (w1 >= 0) & (w2 >= 0)
        if not inside.any():
            return
        iw = 1.0 / np.maximum(D, 1e-6)
        iw_pix = w0 * iw[0] + w1 * iw[1] + w2 * iw[2]
        depth = 1.0 / np.maximum(iw_pix, 1e-9)
        zb = self.zbuf[ymin:ymax + 1, xmin:xmax + 1]
        valid = inside & (depth < zb)
        if not valid.any():
            return

        def lerp(a):
            return (w0 * a[0] * iw[0] + w1 * a[1] * iw[1] + w2 * a[2] * iw[2]) / iw_pix

        Rc, Gc, Bc = lerp(R), lerp(G), lerp(B)
        if tex is None:
            rgb = np.stack([Rc, Gc, Bc], axis=-1)
        else:
            TH, TW = tex.shape[0], tex.shape[1]
            Uc = np.clip(lerp(U) * (TW - 1), 0, TW - 1).astype(np.int32)
            Vc = np.clip(lerp(V) * (TH - 1), 0, TH - 1).astype(np.int32)
            tr = tex[Vc, Uc]
            alpha = tr[..., 3:4]
            rgb = tr[..., :3] * np.stack([Rc, Gc, Bc], axis=-1)
            rgb = rgb * alpha + self.bg * (1.0 - alpha)
        yy, xx = np.nonzero(valid)
        if len(yy):
            self.img[ymin + yy, xmin + xx] = rgb[valid]
            self.zbuf[ymin + yy, xmin + xx] = depth[valid]


def scene_params(mw, size, pad=40, fov_deg=42, cam_mult=2.6):
    """Shared projection setup: center on vertex mean, weak-perspective f, cam dist."""
    allv = np.array([v['pos'] for v in mw.vertices], np.float64)
    center = allv.mean(axis=0) if len(allv) else np.zeros(3)
    maxr = float(np.abs(allv - center).max()) if len(allv) else 100.0
    D = cam_mult * max(maxr, 1e-6)
    f = (size / 2 - pad) / math.tan(math.radians(fov_deg / 2))
    return center, D, f


def project_point(pos, center, D, f, size):
    """Project one world-space point (used by overlay_refs, matches render_level)."""
    q = np.array(pos, np.float64) - center
    qz = q[2] + D
    return f * q[0] / qz + size / 2, -f * q[1] / qz + size / 2


def render_level(mw, yaw, pitch, size=760, pad=40, texdir=None, with_tex=True):
    """Textured z-buffer render. texdir=None -> no textures (flat shaded colors)."""
    bgv = mw.background_color
    bg = (int(bgv[0] * 255), int(bgv[1] * 255), int(bgv[2] * 255)) if bgv else BG
    rast = Raster(size, size, bg=bg)
    center, D, f = scene_params(mw, size, pad)
    P = np.array([v['pos'] for v in mw.vertices], np.float64)
    N = np.array([v['normal'] for v in mw.vertices], np.float64)
    cy, sy = math.cos(yaw), math.sin(yaw)
    cx, sx = math.cos(pitch), math.sin(pitch)
    Rx = np.array([[1, 0, 0], [0, cx, -sx], [0, sx, cx]], np.float64)
    Ry = np.array([[cy, 0, sy], [0, 1, 0], [-sy, 0, cy]], np.float64)
    Q = (P - center) @ (Rx @ Ry).T
    qz = np.maximum(Q[:, 2] + D, 0.5)
    X = f * Q[:, 0] / qz + size / 2
    Y = -f * Q[:, 1] / qz + size / 2
    shade = _AMBIENT + (1.0 - _AMBIENT) * np.clip(N @ _LIGHT, 0, 1)
    verts = mw.vertices

    def walk(node):
        if node['children']:
            for c in node['children']:
                yield from walk(c)  # MUST be yield from, bare call drops subtree
            return
        for geom in node['geoms']:
            mat = geom['material']
            tex = None
            if with_tex and texdir and mat:
                tex = load_tex(mat['texture'], texdir)
                if mat['texture'] and tex is None:
                    tex = checker_tex(mat['diffuse'])
            dif = np.array(mat['diffuse'][:3] if mat else [0.8, 0.8, 0.8], np.float64)
            for strip in geom['strips']:
                tn, off = strip['triangles'], strip['vertex_offset']
                if off + tn + 2 > len(verts) or tn < 1:
                    continue
                for i in range(tn):
                    i0, i1, i2 = off + i, off + i + 1, off + i + 2
                    rast.draw(
                        np.array([X[i0], X[i1], X[i2]]),
                        np.array([Y[i0], Y[i1], Y[i2]]),
                        np.array([qz[i0], qz[i1], qz[i2]]),
                        np.array([verts[i0]['uv'][0], verts[i1]['uv'][0], verts[i2]['uv'][0]]),
                        np.array([verts[i0]['uv'][1], verts[i1]['uv'][1], verts[i2]['uv'][1]]),
                        np.array([shade[i0] * dif[0], shade[i1] * dif[0], shade[i2] * dif[0]]),
                        np.array([shade[i0] * dif[1], shade[i1] * dif[1], shade[i2] * dif[1]]),
                        np.array([shade[i0] * dif[2], shade[i1] * dif[2], shade[i2] * dif[2]]),
                        tex)

    for _ in walk(mw.octree):
        pass
    return Image.fromarray((np.clip(rast.img, 0, 1) * 255).astype(np.uint8), 'RGB')


def classify(name):
    n = name.upper()
    if n.startswith('START'):
        return 'start'
    if n.startswith('SAFESPOT') or n.startswith('SAFEPOS'):
        return 'safe'
    if n.startswith('FLAG'):
        return 'flag'
    if n.startswith('BADBALL') or n == 'BIGBADBALL':
        return 'badball'
    if n.startswith('SECRET'):
        return 'secret'
    if n.startswith('MOUSETRAP'):
        return 'trap'
    if n.startswith('CAMERA'):
        return 'cam'
    return None


STYLE = {
    'start':   ((0, 255, 90), 8),
    'safe':    ((80, 160, 255), 4),
    'flag':    ((255, 255, 255), 3),
    'badball': ((255, 60, 60), 5),
    'secret':  ((255, 220, 40), 5),
    'trap':    ((255, 120, 0), 5),
    'cam':     ((200, 200, 200), 3),
}


def overlay_refs(mw, map_img, size=760, pad=40):
    """Draw S1 ref-point markers on a top-down render. Uses the SAME projection
    math as render_level(yaw=0,pitch=0) so markers land on the geometry."""
    dr = ImageDraw.Draw(map_img)
    if not mw.ref_points or not mw.vertices:
        return map_img
    center, D, f = scene_params(mw, size, pad)
    for rp in mw.ref_points:
        cls = classify(rp['name'])
        if not cls:
            continue
        x, y = project_point(rp['pos'], center, D, f, size)
        color, r = STYLE[cls]
        if cls == 'start':
            dr.ellipse([x - r, y - r, x + r, y + r], outline=color, width=2)
            dr.ellipse([x - 2, y - 2, x + 2, y + 2], fill=color)
        elif cls == 'flag':
            dr.polygon([(x, y - r), (x + r * 0.7, y), (x, y + r),
                        (x - r * 0.7, y)], outline=color, width=1)
        else:
            dr.ellipse([x - r, y - r, x + r, y + r], fill=color)
    return map_img


def orbit_gif(mw, out, frames=40, pitch_deg=30, size=560, dur=85, texdir=None):
    imgs = [render_level(mw, math.radians(i * 360 / frames), math.radians(pitch_deg),
                         size=size, texdir=texdir)
            for i in range(frames)]
    imgs[0].save(out, save_all=True, append_images=imgs[1:],
                 duration=dur, loop=0, optimize=False)
    return out


def find_texdir(level_file):
    base = os.path.dirname(os.path.abspath(level_file))
    for cand in (os.path.join(base, 'Textures'), os.path.join(base, '..', 'Textures')):
        if os.path.isdir(cand):
            return cand
    return None


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest='cmd', required=True)

    p = sub.add_parser('single')
    p.add_argument('file'); p.add_argument('--out', required=True)
    p.add_argument('--yaw', type=float, default=0.0)
    p.add_argument('--pitch', type=float, default=0.0)
    p.add_argument('--size', type=int, default=760)
    p.add_argument('--texdir', default=None)
    p.add_argument('--parser-dir', default=None)

    p = sub.add_parser('orbit')
    p.add_argument('file'); p.add_argument('--out', required=True)
    p.add_argument('--frames', type=int, default=40)
    p.add_argument('--pitch', type=float, default=30.0)
    p.add_argument('--size', type=int, default=560)
    p.add_argument('--dur', type=int, default=85)
    p.add_argument('--texdir', default=None)
    p.add_argument('--parser-dir', default=None)

    p = sub.add_parser('overlay')
    p.add_argument('file'); p.add_argument('--map', required=True)
    p.add_argument('--out', required=True); p.add_argument('--size', type=int, default=760)
    p.add_argument('--parser-dir', default=None)

    p = sub.add_parser('atlas')
    p.add_argument('dir'); p.add_argument('--outdir', required=True)
    p.add_argument('--overlay', action='store_true')
    p.add_argument('--texdir', default=None)
    p.add_argument('--parser-dir', default=None)

    p = sub.add_parser('stats')
    p.add_argument('file')
    p.add_argument('--parser-dir', default=None)

    a = ap.parse_args()
    MeshWorldFile = load_parser(getattr(a, 'parser_dir', None))

    if a.cmd == 'single':
        mw = MeshWorldFile.parse(a.file)
        texdir = a.texdir or find_texdir(a.file)
        img = render_level(mw, math.radians(a.yaw), math.radians(a.pitch),
                           size=a.size, texdir=texdir)
        img.save(a.out); print('saved', a.out)

    elif a.cmd == 'orbit':
        mw = MeshWorldFile.parse(a.file)
        texdir = a.texdir or find_texdir(a.file)
        orbit_gif(mw, a.out, frames=a.frames, pitch_deg=a.pitch, size=a.size,
                  dur=a.dur, texdir=texdir)
        print('saved', a.out)

    elif a.cmd == 'overlay':
        mw = MeshWorldFile.parse(a.file)
        img = Image.open(a.map).convert('RGB')
        overlay_refs(mw, img, size=a.size)
        img.save(a.out); print('saved', a.out)

    elif a.cmd == 'atlas':
        os.makedirs(a.outdir, exist_ok=True)
        texdir = a.texdir or find_texdir(os.path.join(a.dir, os.listdir(a.dir)[0]))
        for fn in sorted(os.listdir(a.dir)):
            if not fn.upper().endswith('.MESHWORLD'):
                continue
            path = os.path.join(a.dir, fn)
            mw = MeshWorldFile.parse(path)
            base = os.path.splitext(fn)[0]
            img = render_level(mw, 0.0, 0.0, size=760, texdir=texdir)
            img.save(os.path.join(a.outdir, base + '.png'))
            if a.overlay:
                overlay_refs(mw, img, size=760)
                img.save(os.path.join(a.outdir, base + '_map.png'))
            print('rendered', fn)

    elif a.cmd == 'stats':
        mw = MeshWorldFile.parse(a.file)
        named = mw.get_named_geoms()
        print(f"verts={len(mw.vertices)} refs={len(mw.ref_points)} "
              f"named_geoms={len(named)} lights={len(mw.lights)} "
              f"splines={len(mw.splines)}")


if __name__ == '__main__':
    main()
