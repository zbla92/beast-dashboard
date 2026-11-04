#!/usr/bin/env python3
import os, re, shutil, subprocess, tempfile

PUBLIC = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "public")
SRC = os.path.join(PUBLIC, "icon.svg")
CHROME = os.environ.get("CHROME") or shutil.which("google-chrome") or shutil.which("chromium") or "/usr/bin/google-chrome"


def render(svg, size, out, tmp, transparent):
    src = os.path.join(tmp, f"{size}-{transparent}.svg")
    open(src, "w").write(svg)
    page = os.path.join(tmp, f"{size}-{transparent}.html")
    open(page, "w").write(f'<html><body style="margin:0;background:transparent"><img src="file://{src}" width="{size}" height="{size}" style="display:block"></body></html>')
    subprocess.run([CHROME, "--headless=new", "--no-sandbox", "--disable-gpu", "--hide-scrollbars", f"--user-data-dir={os.path.join(tmp, 'profile')}",
                    "--default-background-color=00000000" if transparent else "--default-background-color=000000FF",
                    f"--window-size={size},{size}", f"--screenshot={out}", "file://" + page],
                   check=True, timeout=90, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


def main():
    svg = open(SRC).read()
    flat = re.sub(r'rx="11[35]"', 'rx="0"', svg)
    safe = flat.replace('<g id="mark">', '<g id="mark" transform="translate(256 256) scale(.78) translate(-271 -256)">')
    jobs = [("icon-180.png", flat, 180, False), ("icon-192.png", svg, 192, True), ("icon-512.png", svg, 512, True), ("icon-512-maskable.png", safe, 512, False)]
    with tempfile.TemporaryDirectory() as tmp:
        for name, source, size, transparent in jobs:
            path = os.path.join(PUBLIC, name)
            render(source, size, path, tmp, transparent)
            print(f"{name}: {size}x{size}, {os.path.getsize(path)} bytes")


if __name__ == "__main__":
    main()
