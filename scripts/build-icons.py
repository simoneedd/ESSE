"""Genera le icone PNG della PWA dallo stesso disegno di public/icon.svg (Pillow)."""
import sys
from PIL import Image, ImageDraw

def icon(size: int, maskable: bool = False) -> Image.Image:
    s = size / 512
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    if maskable:
        d.rectangle([0, 0, size, size], fill="#1f6f63")
        k = 0.8  # area sicura per le icone mascherabili
        off = size * (1 - k) / 2
        s = s * k
    else:
        d.rounded_rectangle([0, 0, size - 1, size - 1], radius=int(112 * s), fill="#1f6f63")
        off = 0
    pts = [(168, 152), (344, 152), (344, 196), (216, 196), (216, 236), (328, 236), (328, 278), (216, 278), (216, 320), (344, 320), (344, 364), (168, 364)]
    d.polygon([(off + x * s, off + y * s) for x, y in pts], fill="#ffffff")
    return img

out = sys.argv[1] if len(sys.argv) > 1 else "public/icons"
icon(192).save(f"{out}/icon-192.png")
icon(512).save(f"{out}/icon-512.png")
icon(512, maskable=True).save(f"{out}/maskable-512.png")
print("ok")
