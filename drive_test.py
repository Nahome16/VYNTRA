import datetime
import os
import socket
import tempfile
import traceback

from PIL import Image, ImageDraw

from config import Config
from gdrive import DriveUploader


def main():
    cfg = Config()
    print("drive_enabled=", cfg.drive_upload_enabled)
    print("folder_id=", cfg.drive_folder_id)
    print("creds=", cfg.drive_credentials_json)

    if not cfg.drive_upload_enabled:
        raise SystemExit("GoogleDrive.Enabled esta en false. Activalo en config.ini para probar Drive.")

    uploader = DriveUploader(cfg)
    print("DriveUploader initialized with folder", uploader.folder_id)

    now = datetime.datetime.now()
    folder_parts = [
        socket.gethostname(),
        f"{now.year:04d}",
        f"{now.month:02d}",
        f"{now.day:02d}",
    ]

    path = os.path.join(tempfile.gettempdir(), f"vyntra_drive_test_{now:%Y%m%d_%H%M%S}.webp")
    img = Image.new("RGB", (420, 180), color=(0, 29, 57))
    draw = ImageDraw.Draw(img)
    draw.text((24, 36), "VYNTRA Drive test", fill=(234, 246, 255))
    draw.text((24, 72), now.isoformat(timespec="seconds"), fill=(123, 189, 232))
    img.save(path, "WEBP", quality=80, optimize=True)

    print("created test image", path)
    print("remote folders", "/".join(folder_parts))
    try:
        result = uploader.upload_image_backup(path, folder_parts)
        print("upload result", result)
    except Exception:
        traceback.print_exc()
    finally:
        if os.path.exists(path):
            os.unlink(path)


if __name__ == "__main__":
    main()
