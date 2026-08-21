"""
Create the Windows icon used by the VYNTRA agent and setup executable.

The file is generated locally so the installer can be built without requiring
external design assets.
"""

from __future__ import annotations

from pathlib import Path

from PIL import Image, ImageDraw, ImageFont


SIZES = (16, 24, 32, 48, 64, 128, 256)


def font_for(size: int) -> ImageFont.ImageFont:
    candidates = (
        r"C:\Windows\Fonts\arialbd.ttf",
        r"C:\Windows\Fonts\segoeuib.ttf",
        r"C:\Windows\Fonts\arial.ttf",
    )
    font_size = int(size * 0.56)
    for candidate in candidates:
        if Path(candidate).exists():
            return ImageFont.truetype(candidate, font_size)
    return ImageFont.load_default()


def make_image(size: int) -> Image.Image:
    image = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    draw = ImageDraw.Draw(image)

    radius = max(3, int(size * 0.18))
    draw.rounded_rectangle(
        (0, 0, size - 1, size - 1),
        radius=radius,
        fill=(82, 122, 255, 255),
    )

    font = font_for(size)
    text = "V"
    bbox = draw.textbbox((0, 0), text, font=font)
    width = bbox[2] - bbox[0]
    height = bbox[3] - bbox[1]
    x = (size - width) / 2 - bbox[0]
    y = (size - height) / 2 - bbox[1] - int(size * 0.02)
    draw.text((x, y), text, font=font, fill=(255, 255, 255, 255))
    return image


def main() -> None:
    root = Path(__file__).resolve().parents[1]
    output = root / "assets" / "vyntra.ico"
    output.parent.mkdir(parents=True, exist_ok=True)

    images = [make_image(size) for size in SIZES]
    images[-1].save(output, sizes=[(size, size) for size in SIZES], append_images=images[:-1])
    print(output)


if __name__ == "__main__":
    main()
