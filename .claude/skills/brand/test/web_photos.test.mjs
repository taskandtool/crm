// web_photos.py keeps the script contract (--help, misuse exits 2 with a Try
// line and nothing on stdout) and does its job on real pictures: a photograph
// becomes a JPEG at most --width wide and under 600 KB, a transparent picture
// a PNG trimmed to its edges, and a second run leaves what is done alone.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, statSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(new URL("../web_photos.py", import.meta.url));
const run = (args, cwd) => spawnSync("python3", [script, ...args], { encoding: "utf8", cwd });
const pillow = spawnSync("python3", ["-c", "import PIL"]).status === 0;

for (const h of ["--help", "-h"]) {
  test(`web_photos ${h} prints the usage and exits 0`, () => {
    const r = run([h]);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /^usage: web_photos\.py/);
  });
}

test("web_photos refuses wrong input with exit 2 and a Try line, writing nothing", () => {
  const dir = mkdtempSync(join(tmpdir(), "web-photos-"));
  for (const [args, said] of [
    [["--bogus"], /unrecognized arguments: --bogus/],
    [[], /name the picture/],
    [["nope.jpg"], /no file nope\.jpg/],
    [[script, script, "--as", "x"], /--as and --crop take one file at a time/],
    [[script, "--crop", "50,0,50,0"], /--crop 50,0,50,0: four percents/],
  ]) {
    const r = run(args, dir);
    assert.equal(r.status, 2, `${args.join(" ")}: ${r.stderr}`);
    assert.equal(r.stdout, "");
    assert.match(r.stderr, said);
    assert.match(r.stderr, /\n {2}Try: /);
  }
  assert.equal(existsSync(join(dir, "brand")), false);
});

test("a photograph is sized for the web, a transparent picture stays a trimmed PNG, and a re-run is left alone", { skip: !pillow && "Pillow is not installed" }, () => {
  const dir = mkdtempSync(join(tmpdir(), "web-photos-"));
  const make = spawnSync("python3", ["-c", `
from PIL import Image
import os
Image.linear_gradient("L").resize((3000, 2000)).convert("RGB").save("20261030-141502-ab12cd-Roof Job.jpg", quality=95)
Image.effect_noise((3000, 2000), 90).convert("RGB").save("noise.jpg", quality=95)
logo = Image.new("RGBA", (400, 300), (0, 0, 0, 0))
logo.paste((200, 30, 30, 255), (100, 50, 300, 250))
logo.save("logo-1a2b3c4d.png")
`], { cwd: dir });
  assert.equal(make.status, 0, make.stderr?.toString());

  let r = run(["20261030-141502-ab12cd-Roof Job.jpg", "logo-1a2b3c4d.png", "--to", "static/images"], dir);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^web_photos: 2 of 2 ready in static\/images\//);
  assert.match(r.stdout, /static\/images\/roof-job\.jpg {2}2400x1600 {2}\d+ KB/);
  assert.match(r.stdout, /static\/images\/logo\.png {2}200x200 {2}\d+ KB {2}transparent/);
  assert.match(r.stdout, /\nNext: /);
  assert.ok(statSync(join(dir, "static/images/roof-job.jpg")).size <= 600 * 1024);

  // A picture that will not compress is made smaller until it fits, never left over the size.
  r = run(["noise.jpg", "--to", "static/images"], dir);
  assert.equal(r.status, 0, r.stderr);
  assert.ok(statSync(join(dir, "static/images/noise.jpg")).size <= 600 * 1024);

  r = run(["20261030-141502-ab12cd-Roof Job.jpg"], dir);
  assert.match(r.stdout, /brand\/images\/roof-job\.jpg/, "brand/images by default");
  r = run(["20261030-141502-ab12cd-Roof Job.jpg", "--to", "static/images"], dir);
  assert.match(r.stdout, /static\/images\/roof-job\.jpg {2}already made at this width since the original last changed, left alone/);

  // Another width is another request: made again, then left alone at that width.
  r = run(["20261030-141502-ab12cd-Roof Job.jpg", "--to", "static/images", "--width", "1600"], dir);
  assert.match(r.stdout, /static\/images\/roof-job\.jpg {2}1600x1067 {2}\d+ KB/);
  r = run(["20261030-141502-ab12cd-Roof Job.jpg", "--to", "static/images", "--width", "1600"], dir);
  assert.match(r.stdout, /left alone/);
  r = run(["logo-1a2b3c4d.png", "--to", "static/images"], dir);
  assert.match(r.stdout, /logo\.png {2}already made at this width/, "a PNG records its request too");

  r = run(["20261030-141502-ab12cd-Roof Job.jpg", "--to", "static/images", "--crop", "0,0,25,0", "--as", "roof"], dir);
  assert.match(r.stdout, /static\/images\/roof\.jpg {2}2250x2000 {2}\d+ KB {2}\(cut 0,0,25,0 from 3000x2000\)/);

  r = run(["logo-1a2b3c4d.png", "--to", "out", "--json"], dir);
  const [w] = JSON.parse(r.stdout);
  assert.deepEqual([w.path, w.width, w.height, w.transparent], ["out/logo.png", 200, 200, true]);
});
