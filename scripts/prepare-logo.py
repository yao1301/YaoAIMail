from __future__ import annotations

import argparse
from collections import deque
from pathlib import Path

from PIL import Image


def prepare(source: Path, out_dir: Path) -> None:
    image = Image.open(source).convert("RGB")
    width, height = image.size
    pixels = image.load()

    # The supplied PNG contains a checkerboard preview background rather than
    # real alpha. Remove only neutral pixels connected to the outer border;
    # the white "yao" lettering is surrounded by orange and remains intact.
    neutral = [[False] * width for _ in range(height)]
    for y in range(height):
        for x in range(width):
            r, g, b = pixels[x, y]
            neutral[y][x] = max(r, g, b) - min(r, g, b) <= 18 and min(r, g, b) >= 180

    background = [[False] * width for _ in range(height)]
    queue: deque[tuple[int, int]] = deque()
    for x in range(width):
        if neutral[0][x]:
            queue.append((x, 0))
        if neutral[height - 1][x]:
            queue.append((x, height - 1))
    for y in range(height):
        if neutral[y][0]:
            queue.append((0, y))
        if neutral[y][width - 1]:
            queue.append((width - 1, y))

    while queue:
        x, y = queue.popleft()
        if x < 0 or x >= width or y < 0 or y >= height or background[y][x] or not neutral[y][x]:
            continue
        background[y][x] = True
        for nx, ny in ((x - 1, y), (x + 1, y), (x, y - 1), (x, y + 1)):
            if 0 <= nx < width and 0 <= ny < height and not background[ny][nx] and neutral[ny][nx]:
                queue.append((nx, ny))

    rgba = Image.new("RGBA", (width, height), (0, 0, 0, 0))
    out = rgba.load()
    for y in range(height):
        for x in range(width):
            r, g, b = pixels[x, y]
            out[x, y] = (r, g, b, 0 if background[y][x] else 255)

    bbox = rgba.getchannel("A").getbbox()
    if bbox is None:
        raise RuntimeError("Logo foreground could not be detected")
    cropped = rgba.crop(bbox)
    side = max(cropped.size)
    square = Image.new("RGBA", (side, side), (0, 0, 0, 0))
    square.paste(cropped, ((side - cropped.width) // 2, (side - cropped.height) // 2), cropped)

    out_dir.mkdir(parents=True, exist_ok=True)
    sizes = [16, 24, 30, 32, 44, 48, 64, 71, 89, 107, 128, 142, 150, 256, 284, 310, 512, 1024]
    rendered: dict[int, Image.Image] = {}
    for size in sizes:
        rendered[size] = square.resize((size, size), Image.Resampling.LANCZOS)

    rendered[32].save(out_dir / "32x32.png")
    rendered[128].save(out_dir / "128x128.png")
    rendered[256].save(out_dir / "128x128@2x.png")
    rendered[1024].save(out_dir / "icon.png")
    rendered[1024].save(out_dir / "Square1024x1024Logo.png")
    for size in (30, 44, 71, 89, 107, 142, 150, 284, 310, 512):
        rendered[size].save(out_dir / f"Square{size}x{size}Logo.png")
    rendered[256].save(out_dir / "icon.ico", format="ICO", sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (96, 96), (128, 128), (256, 256)])


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("source", type=Path)
    parser.add_argument("out_dir", type=Path)
    args = parser.parse_args()
    prepare(args.source, args.out_dir)
