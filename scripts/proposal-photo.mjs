#!/usr/bin/env node
// A photograph ready for the proposal page: into brand/images/ as WebP, at
// most 1600px wide and 600 KB (what the page build takes), a share cut off
// any edge first when a logo, words or a frame are laid on it. Pillow does
// the work (setup.sh installs it).
//
//   node scripts/proposal-photo.mjs raw/site/<host>/images/coe-road.jpg --crop 0,0,25,0
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, statSync } from "node:fs";
import { basename, extname, join } from "node:path";
import { done, fail, flag, misused, parseArgs, plain } from "../src/data/cli.mjs";

const DIR = "brand/images";
const MAX_WIDTH = 1600, MAX_BYTES = 600 * 1024;
const HELP = `usage: node scripts/proposal-photo.mjs <file> [--crop left,top,right,bottom] [--as <name>]
       node scripts/proposal-photo.mjs <file> <file> ...

Puts a photograph in ${DIR}/ for the proposal's components: WebP, at most
${MAX_WIDTH}px wide and ${MAX_BYTES / 1024} KB, a transparent one kept transparent. The
same file in again replaces its copy.

  --crop   percent cut off each edge, left,top,right,bottom: 0,0,25,0 drops
           the right quarter (a logo in a corner), 3,3,3,3 a thin frame
  --as     the name in ${DIR}/ (default: the file's own, less a crawl's hash)

Prints each file written with its pixels and size, and the photo("…") line
a component names it by. Exit 1 when a file is missing or cannot be read;
2 when misused.`;

const PY = `
import io, json, sys
from PIL import Image, ImageOps
src, dest, l, t, r, b = sys.argv[1], sys.argv[2], *map(float, sys.argv[3:7])
max_w, max_bytes = int(sys.argv[7]), int(sys.argv[8])
im = ImageOps.exif_transpose(Image.open(src))
alpha = im.mode in ("RGBA", "LA") or (im.mode == "P" and "transparency" in im.info)
im = im.convert("RGBA" if alpha else "RGB")
w, h = im.size
im = im.crop((round(w * l / 100), round(h * t / 100), w - round(w * r / 100), h - round(h * b / 100)))
if im.width > max_w:
    im = im.resize((max_w, round(im.height * max_w / im.width)), Image.LANCZOS)
while True:
    for q in (85, 78, 70, 62, 55):
        buf = io.BytesIO()
        im.save(buf, "WEBP", quality=q, method=6)
        if buf.tell() <= max_bytes:
            break
    if buf.tell() <= max_bytes or im.width < 400:
        break
    im = im.resize((im.width * 3 // 4, im.height * 3 // 4), Image.LANCZOS)
open(dest, "wb").write(buf.getvalue())
print(json.dumps({"width": im.width, "height": im.height, "bytes": buf.tell(), "quality": q, "was": [w, h]}))
`;

/** The name it gets in brand/images/: --as (a picture's extension on it dropped), else the file's own less a crawl's "-1a2b3c4d" hash. */
const nameOf = (file, as) =>
  (as !== undefined ? as.replace(/\.(jpe?g|png|webp|gif|avif)$/i, "") : basename(file, extname(file)).replace(/-[0-9a-f]{8}$/, ""))
    .toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

/** --crop's four percents, or null when malformed: each 0 to 90, and what is cut from opposite edges leaves something. */
function cropOf(text) {
  const p = String(text).split(",").map((x) => x.trim());
  if (p.length !== 4 || !p.every((x) => /^\d{1,2}(\.\d+)?$/.test(x))) return null;
  const [l, t, r, b] = p.map(Number);
  return l + r < 90 && t + b < 90 ? [l, t, r, b] : null;
}

const a = parseArgs(process.argv.slice(2));
plain(a, HELP, "proposal-photo", { flags: ["crop", "as"], args: true });
const tryCmd = "node scripts/proposal-photo.mjs raw/site/<host>/images/<file> --crop 0,0,25,0";
if (!a._.length) misused("proposal-photo: name a photograph", tryCmd);
const cropText = flag(a, "crop"), as = flag(a, "as");
if (a._.length > 1 && (cropText || as)) misused("proposal-photo: --crop and --as take one file at a time", tryCmd);
const crop = cropText === undefined ? [0, 0, 0, 0] : cropOf(cropText);
if (!crop) misused(`proposal-photo: --crop ${cropText}; write four percents, left,top,right,bottom, each edge pair under 90 (0,0,25,0)`, tryCmd);
if (as !== undefined && !nameOf("x", as)) misused(`proposal-photo: --as ${as} is not a file name`, tryCmd);

mkdirSync(DIR, { recursive: true });
const lines = [];
for (const file of a._) {
  if (!existsSync(file) || !statSync(file).isFile()) fail(`proposal-photo: no file ${file}`, "ls raw/site/*/images/");
  const dest = join(DIR, `${nameOf(file, as)}.webp`);
  const had = existsSync(dest);
  let r;
  try {
    r = JSON.parse(execFileSync("python3", ["-c", PY, file, dest, ...crop.map(String), String(MAX_WIDTH), String(MAX_BYTES)], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }));
  } catch (e) {
    const why = String(e.stderr || e.message);
    if (/No module named .PIL/.test(why)) fail("proposal-photo: Pillow is not installed", "bash .taskandtool/setup.sh");
    fail(`proposal-photo: ${file} could not be read as a picture (${why.trim().split("\n").pop()})`, "pass a .jpg, .png or .webp");
  }
  const cut = crop.some(Boolean) ? `, cut ${["left", "top", "right", "bottom"].map((e, i) => (crop[i] ? `${crop[i]}% ${e}` : "")).filter(Boolean).join(", ")} from ${r.was[0]} x ${r.was[1]}` : "";
  lines.push(`${had ? "replaced" : "wrote"} ${dest} from ${file}: ${r.width} x ${r.height}, ${Math.ceil(r.bytes / 1024)} KB${cut}`, `  in a component: photo("${dest}")`);
}
done("proposal-photo", `${a._.length} photograph${a._.length === 1 ? "" : "s"} in ${DIR}/`, { lines, next: "look at each one, then npm run css" });
