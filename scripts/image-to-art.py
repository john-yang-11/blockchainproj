# Converts a picture into canvas pixel art for scripts/paint.mjs: resize, then map onto the 16-color palette.
# usage: python scripts/image-to-art.py <in> <width> <dither 0|1> <preview.png> <out.json> [caption]
import json, sys
from PIL import Image, ImageEnhance

PAL = ['FFFFFF', 'E4E4E4', '888888', '222222', 'FFA7D1', 'E50000', 'E59500', 'A06A42',
       'E5D900', '94E044', '02BE01', '00D3DD', '0083C7', '0000EA', 'CF6EE4', '820080']
RGB = [tuple(int(h[i:i + 2], 16) for i in (0, 2, 4)) for h in PAL]
FONT = {
    'H': ['101', '101', '111', '101', '101'], 'U': ['101', '101', '101', '101', '111'],
    'N': ['110', '101', '101', '101', '101'], 'T': ['111', '010', '010', '010', '010'],
    'R': ['110', '101', '110', '101', '101'], 'X': ['101', '101', '010', '101', '101'],
    '/': ['001', '001', '010', '100', '100'], ' ': ['000'] * 5,
}

src = Image.open(sys.argv[1]).convert('RGB')
n, dither = int(sys.argv[2]), sys.argv[3] == '1'
caption = sys.argv[6] if len(sys.argv) > 6 else ''
# A little extra saturation/contrast survives the 16-color palette better.
src = ImageEnhance.Contrast(ImageEnhance.Color(src).enhance(1.3)).enhance(1.15)
h = round(n * src.height / src.width)
small = src.resize((n, h), Image.LANCZOS)

pal_img = Image.new('P', (1, 1))
# Pad the unused slots with a real palette color so quantize never picks an index past 15.
pal_img.putpalette([v for c in RGB for v in c] + list(RGB[3]) * (256 - 16))
q = small.quantize(palette=pal_img, dither=Image.Dither.FLOYDSTEINBERG if dither else Image.Dither.NONE)
pixels = [[x, y, q.getpixel((x, y))] for y in range(h) for x in range(n)]

if caption:
    # Caption in black on a white band under the picture.
    w = len(caption) * 4 - 1
    x0, y0 = (n - w) // 2, h + 2
    for i, ch in enumerate(caption):
        for dy, row in enumerate(FONT[ch]):
            for dx, b in enumerate(row):
                if b == '1':
                    pixels.append([x0 + i * 4 + dx, y0 + dy, 3])
    h += 7

prev = Image.new('RGB', (n, h), (255, 255, 255))
for x, y, c in pixels:
    prev.putpixel((x, y), RGB[c])
prev.resize((n * 8, h * 8), Image.NEAREST).save(sys.argv[4])
json.dump({'width': n, 'height': h, 'pixels': pixels}, open(sys.argv[5], 'w'))
print(f'{n}x{h}, {len(pixels)} pixels, {sum(1 for p in pixels if p[2] != 0)} non-white')
