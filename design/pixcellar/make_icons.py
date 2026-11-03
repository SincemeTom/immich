"""Makes the Pixcellar app icons from icon-1024.png (1024x1024, opaque): iOS, Android (legacy, adaptive, themed) and
the Play Store's. Needs Pillow.

Usage: python3 design/pixcellar/make_icons.py      (from the repository root)
"""

import json
from pathlib import Path

from PIL import Image, ImageFilter

ROOT = Path(__file__).resolve().parents[2]
HERE = Path(__file__).resolve().parent
MASTER = Image.open(HERE / "icon-1024.png").convert("RGB")
# the light grey behind the petals, for the adaptive icon's background layer
BACKGROUND = (237, 236, 234)

IOS = ROOT / "mobile/ios/Runner/Assets.xcassets/AppIcon.appiconset"
RES = ROOT / "mobile/android/app/src/main/res"
DENSITIES = {"mdpi": 1, "hdpi": 1.5, "xhdpi": 2, "xxhdpi": 3, "xxxhdpi": 4}


def petals_mask(image: Image.Image) -> Image.Image:
    """The petals, as an alpha mask: they are saturated, the grey around and between them is not"""
    r, g, b = (channel.load() for channel in image.split())
    mask = Image.new("L", image.size)
    out = mask.load()
    for y in range(image.height):
        for x in range(image.width):
            values = (r[x, y], g[x, y], b[x, y])
            saturation = max(values) - min(values)
            out[x, y] = max(0, min(255, (saturation - 12) * 255 // 28))
    return mask.filter(ImageFilter.GaussianBlur(0.6))


def adaptive_layer(content: Image.Image, size: int, fraction: float) -> Image.Image:
    """content (RGBA) centered on a transparent square of size, its larger side fraction of it"""
    box = content.getbbox() or (0, 0, *content.size)
    cropped = content.crop(box)
    scale = size * fraction / max(cropped.size)
    resized = cropped.resize((round(cropped.width * scale), round(cropped.height * scale)), Image.LANCZOS)
    layer = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    layer.paste(resized, ((size - resized.width) // 2, (size - resized.height) // 2), resized)
    return layer


def main() -> None:
    # iOS: every size the asset catalog names (the file name is its size in pixels), opaque
    names = {image["filename"] for image in json.loads((IOS / "Contents.json").read_text())["images"] if "filename" in image}
    for name in names:
        size = int(Path(name).stem)
        MASTER.resize((size, size), Image.LANCZOS).save(IOS / name, optimize=True)

    # Android, before 8: the whole icon
    for density, factor in DENSITIES.items():
        size = round(48 * factor)
        MASTER.resize((size, size), Image.LANCZOS).save(RES / f"mipmap-{density}/ic_launcher.png", optimize=True)

    # Android 8+: adaptive, 108 dp layers whose middle 66 dp circle always shows; the petals reach about 0.78 of
    # their width from the center diagonally (0.55 of it), so at 0.55 of the layer they stay within it
    mask = petals_mask(MASTER)
    petals = MASTER.convert("RGBA")
    petals.putalpha(mask)
    white = Image.new("RGBA", MASTER.size, (255, 255, 255, 0))
    white.putalpha(mask)
    for density, factor in DENSITIES.items():
        size = round(108 * factor)
        folder = RES / f"drawable-{density}"
        folder.mkdir(exist_ok=True)
        adaptive_layer(petals, size, 0.55).save(folder / "ic_launcher_foreground.png", optimize=True)
        # Android 13+ themed icons: the shape only, which the system colors
        adaptive_layer(white, size, 0.55).save(folder / "ic_launcher_monochrome.png", optimize=True)

    # Play Store: 512, opaque
    MASTER.resize((512, 512), Image.LANCZOS).save(HERE / "play-store-512.png", optimize=True)
    # a preview of the adaptive icon as a launcher shows it: the middle 72 dp of the 108, under a circle mask
    from PIL import ImageDraw

    preview = Image.new("RGBA", (432, 432), (*BACKGROUND, 255))
    preview.alpha_composite(adaptive_layer(petals, 432, 0.55))
    preview = preview.crop((72, 72, 360, 360))
    circle = Image.new("L", preview.size)
    ImageDraw.Draw(circle).ellipse((0, 0, preview.width - 1, preview.height - 1), fill=255)
    preview.putalpha(circle)
    preview.save(HERE / "android-adaptive-preview.png")
    print("done")


if __name__ == "__main__":
    main()
