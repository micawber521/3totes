"""Minimal TrueType reader: text -> SVG path data (simple glyphs, quadratic outlines). Stdlib only."""
import struct, sys
class TTF:
    def __init__(self, path):
        self.d = d = open(path, 'rb').read()
        n = struct.unpack('>H', d[4:6])[0]
        self.t = {d[12+16*i:16+16*i].decode('latin1'): struct.unpack('>II', d[20+16*i:28+16*i]) for i in range(n)}
        self.upm = struct.unpack('>H', self.tab('head')[18:20])[0]
        self.locfmt = struct.unpack('>h', self.tab('head')[50:52])[0]
        self.nglyphs = struct.unpack('>H', self.tab('maxp')[4:6])[0]
        self.nhm = struct.unpack('>H', self.tab('hhea')[34:36])[0]
        self.cmap = self._cmap()
    def tab(self, n):
        o, l = self.t[n]; return self.d[o:o+l]
    def _cmap(self):
        c = self.tab('cmap'); n = struct.unpack('>H', c[2:4])[0]
        for i in range(n):
            pid, eid, off = struct.unpack('>HHI', c[4+8*i:12+8*i])
            if struct.unpack('>H', c[off:off+2])[0] == 4: break
        s = c[off:]; segx2 = struct.unpack('>H', s[6:8])[0]; sc = segx2 // 2
        ends = struct.unpack(f'>{sc}H', s[14:14+segx2]); b = 16+segx2
        starts = struct.unpack(f'>{sc}H', s[b:b+segx2]); deltas = struct.unpack(f'>{sc}h', s[b+segx2:b+2*segx2])
        roff_pos = b+2*segx2; roffs = struct.unpack(f'>{sc}H', s[roff_pos:roff_pos+segx2])
        m = {}
        for i in range(sc):
            for ch in range(starts[i], ends[i]+1):
                if ch == 0xFFFF: continue
                if roffs[i] == 0: g = (ch + deltas[i]) & 0xFFFF
                else:
                    p = roff_pos + 2*i + roffs[i] + 2*(ch - starts[i])
                    g = struct.unpack('>H', s[p:p+2])[0]
                    if g: g = (g + deltas[i]) & 0xFFFF
                m[ch] = g
        return m
    def advance(self, g):
        h = self.tab('hmtx'); g = min(g, self.nhm-1); return struct.unpack('>H', h[4*g:4*g+2])[0]
    def contours(self, g):
        loca = self.tab('loca')
        if self.locfmt: a, b = struct.unpack('>II', loca[4*g:4*g+8])
        else: a, b = (x*2 for x in struct.unpack('>HH', loca[2*g:2*g+4]))
        if a == b: return []
        gl = self.tab('glyf')[a:b]; nc = struct.unpack('>h', gl[:2])[0]
        assert nc >= 0, 'composite glyph not supported'
        ends = struct.unpack(f'>{nc}H', gl[10:10+2*nc]); p = 10+2*nc
        il = struct.unpack('>H', gl[p:p+2])[0]; p += 2+il; npts = ends[-1]+1
        flags = []
        while len(flags) < npts:
            f = gl[p]; p += 1; flags.append(f)
            if f & 8: r = gl[p]; p += 1; flags += [f]*r
        def coords(short, same):
            out, v = [], 0
            nonlocal p
            for f in flags:
                if f & short:
                    dv = gl[p]; p += 1; v += dv if f & same else -dv
                elif not f & same:
                    v += struct.unpack('>h', gl[p:p+2])[0]; p += 2
                out.append(v)
            return out
        xs = coords(2, 16); ys = coords(4, 32)
        res, s = [], 0
        for e in ends:
            res.append([(xs[i], ys[i], bool(flags[i] & 1)) for i in range(s, e+1)]); s = e+1
        return res
def contour_d(pts, ox, scale, base):
    X = lambda x: ox + x*scale; Y = lambda y: base - y*scale
    n = len(pts)
    # start at an on-curve point (or midpoint of two off-curve)
    k = next((i for i, p in enumerate(pts) if p[2]), None)
    if k is None:
        a, b = pts[0], pts[1]; start = ((a[0]+b[0])/2, (a[1]+b[1])/2); seq = pts[1:]+pts[:1]
    else:
        start = pts[k][:2]; seq = pts[k+1:]+pts[:k]
    d = [f'M{X(start[0]):.2f},{Y(start[1]):.2f}']; ctrl = None
    for x, y, on in seq + [(start[0], start[1], True)]:
        if on:
            d.append(f'Q{X(ctrl[0]):.2f},{Y(ctrl[1]):.2f} {X(x):.2f},{Y(y):.2f}' if ctrl else f'L{X(x):.2f},{Y(y):.2f}'); ctrl = None
        else:
            if ctrl:
                mx, my = (ctrl[0]+x)/2, (ctrl[1]+y)/2
                d.append(f'Q{X(ctrl[0]):.2f},{Y(ctrl[1]):.2f} {X(mx):.2f},{Y(my):.2f}')
            ctrl = (x, y)
    return ''.join(d) + 'Z'
def text_path(font, text, x, baseline, size, tracking=0):
    scale = size / font.upm; d = []; ox = x
    for ch in text:
        g = font.cmap.get(ord(ch), 0)
        for c in font.contours(g): d.append(contour_d(c, ox, scale, baseline))
        ox += font.advance(g)*scale + tracking
    return ''.join(d), ox - x - tracking
