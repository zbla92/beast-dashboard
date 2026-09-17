#!/usr/bin/env python3
"""Pravi ikone za pocetni ekran i za Chrome "Install app".

Rucno, bez biblioteke: beast-dash nema nijednu zavisnost i ne isplati se
dodavati je zbog cetiri slike. Motiv je isti kao favicon u index.html —
teal "B" na tamnom zaobljenom kvadratu.

    ./bin/make-icons.py

Maskable varijanta je namjerno drugacija: Android preko nje navlaci svoj
oblik (krug, squircle...), pa pozadina ide preko CIJELOG kvadrata bez
zaobljenja, a znak je manji da ostane unutar sigurne zone.
"""
import zlib, struct, os

POZ  = (0x0b, 0x0e, 0x14)
ZNAK = (0x5e, 0xea, 0xd4)

GLIF = [
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
GW, GH = len(GLIF[0]), len(GLIF)


def napravi(S, radius_udio=0.22, glif_udio=0.62):
    R = S * radius_udio
    cell = min(S * glif_udio / GW, S * glif_udio / GH * (GW / GH))
    cell = S * glif_udio / GH          # visina vodi — "B" je vise nego sire
    gx, gy = (S - GW * cell) / 2, (S - GH * cell) / 2

    def u_kvadratu(x, y):
        if R <= 0:
            return True
        if x < R and y < R:         return (x - R) ** 2 + (y - R) ** 2 <= R * R
        if x > S - R and y < R:     return (x - (S - R)) ** 2 + (y - R) ** 2 <= R * R
        if x < R and y > S - R:     return (x - R) ** 2 + (y - (S - R)) ** 2 <= R * R
        if x > S - R and y > S - R: return (x - (S - R)) ** 2 + (y - (S - R)) ** 2 <= R * R
        return True

    def u_glifu(x, y):
        c, r = (x - gx) / cell, (y - gy) / cell
        if 0 <= c < GW and 0 <= r < GH:
            return GLIF[int(r)][int(c)] == "1"
        return False

    N = 3                              # 3x3 nadouzorkovanje -> glatke ivice
    red = bytearray()
    for y in range(S):
        red.append(0)                  # filter byte
        for x in range(S):
            pok = zn = 0
            for sy in range(N):
                for sx in range(N):
                    px, py = x + (sx + 0.5) / N, y + (sy + 0.5) / N
                    if u_kvadratu(px, py):
                        pok += 1
                        if u_glifu(px, py):
                            zn += 1
            if pok == 0:
                red += bytes((0, 0, 0, 0))
                continue
            t = zn / pok
            boja = tuple(round(POZ[i] * (1 - t) + ZNAK[i] * t) for i in range(3))
            red += bytes(boja) + bytes((round(255 * pok / (N * N)),))

    def dio(tip, tijelo):
        d = tip + tijelo
        return (struct.pack(">I", len(tijelo)) + d
                + struct.pack(">I", zlib.crc32(d) & 0xffffffff))

    return (b"\x89PNG\r\n\x1a\n"
            + dio(b"IHDR", struct.pack(">IIBBBBB", S, S, 8, 6, 0, 0, 0))
            + dio(b"IDAT", zlib.compress(bytes(red), 9))
            + dio(b"IEND", b""))


if __name__ == "__main__":
    javno = os.path.join(os.path.dirname(__file__), "..", "public")
    posao = [
        ("icon-180.png", 180, 0.22, 0.62),   # apple-touch-icon
        ("icon-192.png", 192, 0.22, 0.62),   # Chrome trazi 192
        ("icon-512.png", 512, 0.22, 0.62),   # i 512
        ("icon-512-maskable.png", 512, 0.0, 0.44),  # bez uglova, znak u sigurnoj zoni
    ]
    for ime, s, r, g in posao:
        p = os.path.join(javno, ime)
        with open(p, "wb") as f:
            n = f.write(napravi(s, r, g))
        print(f"{ime}: {s}x{s}, {n} bajta")
