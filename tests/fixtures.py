"""Generated test data: a fake vehicle with a spin of numbered frames. Nothing here touches a real site or bucket."""
import io
import json
from PIL import Image, ImageDraw

SPIN_FRAMES = 24
W, H = 1280, 720


def frame_jpeg(i, n=SPIN_FRAMES, w=W, h=H):
    """A recognisable stand-in frame: a 'car' block that shifts with the angle, with the frame number written on it."""
    im = Image.new("RGB", (w, h), (28 + i * 4 % 60, 32, 40))
    d = ImageDraw.Draw(im)
    x = int(w * (0.2 + 0.4 * (i / n)))
    d.rounded_rectangle([x, int(h * .35), x + int(w * .35), int(h * .7)], 40, fill=(200, 60 + i * 5 % 150, 50))
    d.text((x + 20, int(h * .45)), f"frame {i}", fill=(255, 255, 255))
    buf = io.BytesIO()
    im.save(buf, "JPEG", quality=80)
    return buf.getvalue()


def vehicle(base, vid="test-spin"):
    ext = [f"{base}/files/ext-{i}.jpg" for i in range(SPIN_FRAMES)]
    return {
        "id": vid, "year": "2022", "make": "Test", "model": "Spinner", "trim": "SE", "stock": "T100",
        "vin": "", "odometer": "12345", "price": "25995", "bodyType": "sedan", "notes": "Test vehicle (generated).",
        "exterior": ext, "interiorShots": [f"{base}/files/int-{i}.jpg" for i in range(8)],
        "coverIndex": 0, "hotspots": [], "panorama": "", "createdAt": 1700000000000, "updatedAt": 1700000000000,
    }


def summary(v):
    return {k: v.get(k, "") for k in ("id", "stock", "year", "make", "model", "trim", "price", "odometer", "bodyType", "vin")} | {
        "title": f"{v['year']} {v['make']} {v['model']} {v['trim']}", "cover": v["exterior"][0], "createdAt": v["createdAt"],
        "v": 2, "updatedAt": v["updatedAt"]}


def png_icon():
    buf = io.BytesIO()
    Image.new("RGB", (192, 192), (242, 183, 5)).save(buf, "PNG")
    return buf.getvalue()


def dump(path):
    json.dump({"frames": SPIN_FRAMES}, open(path, "w"))
