#!/usr/bin/env python3
"""Generates the home-screen / "Install app" icons in public/.

By hand, without a library: Beast Dash has no dependencies and four images are not worth
adding one. The motif is the same as the favicon in index.html — a teal "B" on a dark
rounded square.

    ./bin/make-icons.py

The maskable variant is deliberately different: Android draws its own shape over it (circle,
squircle …), so the background covers the WHOLE square without rounding and the glyph is
smaller to stay inside the safe zone.
"""
import zlib, struct, os

BG    = (0x0b, 0x0e, 0x14)
GLYPH_COLOR = (0x5e, 0xea, 0xd4)

GLYPH = [
    "11111100",
    "11000110",
    "11000110",
    "11000110",
    "11111100",
    "11000110",
    "11000011",
    "11000011",
    "11000011",
    "11000110",
    "11111100",
]
GW, GH = len(GLYPH[0]), len(GLYPH)


def render(S, radius_ratio=0.22, glyph_ratio=0.62):
    R = S * radius_ratio
    cell = S * glyph_ratio / GH          # height leads — the "B" is taller than it is wide
    gx, gy = (S - GW * cell) / 2, (S - GH * cell) / 2

    def in_square(x, y):
        if R <= 0:
            return True
        if x < R and y < R:         return (x - R) ** 2 + (y - R) ** 2 <= R * R
        if x > S - R and y < R:     return (x - (S - R)) ** 2 + (y - R) ** 2 <= R * R
        if x < R and y > S - R:     return (x - R) ** 2 + (y - (S - R)) ** 2 <= R * R
        if x > S - R and y > S - R: return (x - (S - R)) ** 2 + (y - (S - R)) ** 2 <= R * R
        return True

    def in_glyph(x, y):
        c, r = (x - gx) / cell, (y - gy) / cell
        if 0 <= c < GW and 0 <= r < GH:
            return GLYPH[int(r)][int(c)] == "1"
        return False

    N = 3                              # 3x3 supersampling -> smooth edges
    rows = bytearray()
    for y in range(S):
        rows.append(0)                 # filter byte
        for x in range(S):
            covered = glyph = 0
            for sy in range(N):
                for sx in range(N):
                    px, py = x + (sx + 0.5) / N, y + (sy + 0.5) / N
                    if in_square(px, py):
                        covered += 1
                        if in_glyph(px, py):
                            glyph += 1
            if covered == 0:
                rows += bytes((0, 0, 0, 0))
                continue
            t = glyph / covered
            color = tuple(round(BG[i] * (1 - t) + GLYPH_COLOR[i] * t) for i in range(3))
            rows += bytes(color) + bytes((round(255 * covered / (N * N)),))

    def chunk(kind, body):
        d = kind + body
        return (struct.pack(">I", len(body)) + d
                + struct.pack(">I", zlib.crc32(d) & 0xffffffff))

    return (b"\x89PNG\r\n\x1a\n"
            + chunk(b"IHDR", struct.pack(">IIBBBBB", S, S, 8, 6, 0, 0, 0))
            + chunk(b"IDAT", zlib.compress(bytes(rows), 9))
            + chunk(b"IEND", b""))


if __name__ == "__main__":
    public = os.path.join(os.path.dirname(__file__), "..", "public")
    jobs = [
        ("icon-180.png", 180, 0.22, 0.62),   # apple-touch-icon
        ("icon-192.png", 192, 0.22, 0.62),   # Chrome wants 192
        ("icon-512.png", 512, 0.22, 0.62),   # and 512
        ("icon-512-maskable.png", 512, 0.0, 0.44),  # no corners, glyph inside the safe zone
    ]
    for name, s, r, g in jobs:
        p = os.path.join(public, name)
        with open(p, "wb") as f:
            f.write(render(s, r, g))
        print(f"{name}: {os.path.getsize(p)} bytes")
