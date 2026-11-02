#!/usr/bin/env python3
"""Photographs ready for the web, in one place for every app: each file
becomes a JPEG (a transparent picture a PNG, trimmed to its edges) at most
--width wide and under 600 KB, turned upright, a share cut off any edge first
when a logo, words or a frame are laid on it. Pillow does the work.

    python3 .claude/skills/brand/web_photos.py uploads/<file> [--to static/images]
"""
import argparse
import io
import json
import os
import re
import sys

try:
    from PIL import Image, ImageOps
    from PIL.PngImagePlugin import PngInfo
except ImportError:  # said once a picture is to be made, so --help and misuse still answer
    Image = None

MAX_BYTES = 600 * 1024
TRY = "python3 .claude/skills/brand/web_photos.py uploads/<file>"
HELP_END = """Prints each picture written (its path, pixels and size), any left alone
because it was made at this --width since the original last changed, then Next:.
--json prints them as a JSON list instead. Exit 1 when a picture cannot be
read or Pillow is missing; 2 when misused (a missing file, a bad --crop)."""


class Misuse(Exception):
    pass


class Parser(argparse.ArgumentParser):
    def error(self, message):
        raise Misuse(message)


def say(message, lines=(), try_cmd=TRY, code=1, as_json=False):
    """A refusal on stderr, in text or JSON; exits with `code`."""
    if as_json:
        sys.stderr.write(json.dumps({"error": message, "details": list(lines), "try": try_cmd}) + "\n")
    else:
        sys.stderr.write("web_photos: %s\n" % message + "".join("  %s\n" % l for l in lines) + "  Try: %s\n" % try_cmd)
    sys.exit(code)


def name_of(path, given=None):
    """The file's name: --as (a picture's extension dropped), else its own,
    less a chat upload's stamp (20261030-141502-ab12cd-) and a crawl's hash
    (-1a2b3c4d), as lowercase words joined by dashes."""
    if given is not None:
        base = re.sub(r"\.(jpe?g|png|webp|gif|avif|heic)$", "", given, flags=re.I)
    else:
        base = os.path.splitext(os.path.basename(path))[0]
        base = re.sub(r"^\d{8}-\d{6}-[a-z0-9]+-", "", base, flags=re.I)
        base = re.sub(r"-[0-9a-f]{8}$", "", base)
    return re.sub(r"[^a-z0-9]+", "-", base.lower()).strip("-")


def crop_of(text):
    """--crop's four percents (left, top, right, bottom), or None when
    malformed: each under 90, and opposite edges leave something."""
    parts = [p.strip() for p in str(text).split(",")]
    if len(parts) != 4 or not all(re.fullmatch(r"\d{1,2}(\.\d+)?", p) for p in parts):
        return None
    l, t, r, b = map(float, parts)
    return (l, t, r, b) if l + r < 90 and t + b < 90 else None


def asked(width):
    """What a copy records it was made for, so a second run can tell the same
    request (left alone) from a different one (made again)."""
    return "web_photos width=%d" % width


def made_for(path):
    """The request a copy records, or "" for one this script did not make."""
    try:
        info = Image.open(path).info
    except OSError:
        return ""
    v = info.get("web_photos") or info.get("comment") or ""
    return v.decode("utf-8", "replace") if isinstance(v, bytes) else v


def save(im, transparent, mark, quality):
    """The image as JPEG at `quality`, or as PNG, with `mark` recorded in it
    (a JPEG comment, a PNG text chunk)."""
    buf = io.BytesIO()
    if transparent:
        text = PngInfo()
        text.add_text("web_photos", mark)
        im.save(buf, "PNG", optimize=True, pnginfo=text)
    else:
        im.save(buf, "JPEG", quality=quality, optimize=True, progressive=True, comment=mark.encode())
    return buf.getvalue()


def encode(im, transparent, mark):
    """(bytes, image): the first copy under MAX_BYTES, a JPEG's quality down
    first, then a quarter smaller each round; the last try when nothing fits."""
    qualities = (None,) if transparent else (85, 78, 70, 62, 55)
    while True:
        for quality in qualities:
            data = save(im, transparent, mark, quality)
            if len(data) <= MAX_BYTES:
                return data, im
        if min(im.size) < 200:
            return data, im
        im = im.resize((im.width * 3 // 4, im.height * 3 // 4))


def prepare(src, dest_dir, name, crop, width):
    """Writes the web copy; returns what was written."""
    im = ImageOps.exif_transpose(Image.open(src))
    transparent = im.mode in ("RGBA", "LA") or (im.mode == "P" and "transparency" in im.info)
    im = im.convert("RGBA" if transparent else "RGB")
    if transparent:
        box = im.getchannel("A").getbbox()
        transparent = bool(box) and im.getchannel("A").getextrema()[0] < 255
        im = im.crop(box) if box else im
        im = im if transparent else im.convert("RGB")
    was = im.size
    if crop:
        l, t, r, b = crop
        w, h = im.size
        im = im.crop((round(w * l / 100), round(h * t / 100), w - round(w * r / 100), h - round(h * b / 100)))
    if im.width > width:
        im = im.resize((width, round(im.height * width / im.width)), Image.LANCZOS)
    data, im = encode(im, transparent, asked(width))
    dest = os.path.join(dest_dir, "%s.%s" % (name, "png" if transparent else "jpg"))
    os.makedirs(dest_dir, exist_ok=True)
    with open(dest, "wb") as fh:
        fh.write(data)
    return {"path": dest, "source": src, "width": im.width, "height": im.height,
            "kb": -(-len(data) // 1024), "transparent": transparent, "was": list(was)}


def main(argv):
    p = Parser(prog="web_photos.py", description=__doc__.split("\n\n")[0], epilog=HELP_END,
               formatter_class=argparse.RawDescriptionHelpFormatter, allow_abbrev=False)
    p.add_argument("files", nargs="*", metavar="FILE", help="the pictures (files sent in chat are in uploads/)")
    p.add_argument("--to", default="brand/images", metavar="DIR",
                   help="where they go (default brand/images; the app's AGENTS.md says where its pages read them)")
    p.add_argument("--as", dest="name", metavar="NAME", help="the file's name (one file)")
    p.add_argument("--crop", metavar="L,T,R,B",
                   help="percent cut off each edge first: 0,0,25,0 drops the right quarter (a logo in a corner), "
                        "3,3,3,3 a thin frame (one file)")
    p.add_argument("--width", type=int, default=2400, metavar="PX", help="the widest it may be (default 2400)")
    p.add_argument("--json", action="store_true", help="what was written, as a JSON list")
    as_json = "--json" in argv
    try:
        args = p.parse_args(argv)
    except Misuse as e:
        say(str(e), try_cmd="python3 .claude/skills/brand/web_photos.py --help", code=2, as_json=as_json)
    if not args.files:
        say("name the picture(s) to prepare", code=2, as_json=as_json)
    if len(args.files) > 1 and (args.name or args.crop):
        say("--as and --crop take one file at a time", code=2, as_json=as_json)
    crop = crop_of(args.crop) if args.crop else None
    if args.crop and not crop:
        say("--crop %s: four percents, left,top,right,bottom, each edge pair under 90" % args.crop,
            try_cmd=TRY + " --crop 0,0,25,0", code=2, as_json=as_json)
    if args.width < 100:
        say("--width %d is too narrow for a photograph" % args.width, code=2, as_json=as_json)
    missing = [f for f in args.files if not os.path.isfile(f)]
    if missing:
        say("no file %s" % ", ".join(missing), try_cmd="ls uploads/, for the files sent in chat", code=2, as_json=as_json)
    names = [name_of(f, args.name) for f in args.files]
    if not all(names):
        say("%s gives no file name; name it with --as" % args.files[names.index("")], code=2, as_json=as_json)
    twice = next((n for i, n in enumerate(names) if n in names[:i]), None)
    if twice:
        say("two of these would both be %s; run them one at a time with --as" % twice, code=2, as_json=as_json)
    if Image is None:
        say("Pillow is not installed", try_cmd="python3 -m pip install pillow", as_json=as_json)

    written, kept = [], []
    for src, name in zip(args.files, names):
        # Done only when a copy newer than the original was made for this same request.
        there = [os.path.join(args.to, "%s.%s" % (name, ext)) for ext in ("jpg", "png")]
        done = next((d for d in there if os.path.isfile(d) and os.path.getmtime(d) >= os.path.getmtime(src)
                     and made_for(d) == asked(args.width)), None)
        if done and not crop:
            kept.append(done)
            continue
        try:
            written.append(prepare(src, args.to, name, crop, args.width))
        except (OSError, ValueError) as e:
            before = ["written before it: %s" % w["path"] for w in written]
            say("%s could not be read as a picture (%s)" % (src, str(e).split("\n")[0][:200]), before,
                try_cmd="the picture as a .jpg, .png or .webp (an iPhone's HEIC: ask for it as a JPEG)", as_json=as_json)

    if args.json:
        print(json.dumps(written + [{"path": k, "kept": True} for k in kept], indent=2))
        return 0
    lines = ["%s  %dx%d  %d KB%s%s" % (w["path"], w["width"], w["height"], w["kb"], "  transparent" if w["transparent"] else "",
                                       "  (cut %s from %dx%d)" % (args.crop, *w["was"]) if crop else "") for w in written]
    lines += ["%s  already made at this width since the original last changed, left alone" % k for k in kept]
    print("web_photos: %d of %d ready in %s/" % (len(written) + len(kept), len(args.files), args.to))
    print("".join("  %s\n" % l for l in lines), end="")
    print("\nNext: look at each one, then use it by its path, no wider than it prints")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
