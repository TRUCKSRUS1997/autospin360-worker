# AutoSpin360 background worker

Applies AI showroom backgrounds to vehicle spins for AutoSpin360 (Twin Motors GM) after the
dealer taps **Apply to spin**, so the admin app doesn't need to stay open.

- Runs on free GitHub Actions computers (public repository, standard runner).
- Cuts the vehicle out with free MIT-licensed models (BiRefNet Lite, or BEN2 for high quality),
  then builds the finished frames with the site's own background code.
- Only code lives here. Photos are read from and written back to the site; nothing is stored in
  this repository.

Works for every dealership on the site.

`bg_patch.py` adjusts the site's background code before running it, for the turntable looks: the
vehicle no longer hops on the platform, and its reflection meets every wheel so it stands on the floor.

Secret needed: `BG_WORKER_KEY` (same value as the `BG_WORKER_KEY` secret on Cloudflare).

**2026-10-21:** cut-outs are refined at the photo's own size (up to 2048 px) with a colour guided
filter and averaged with the mirrored frame, which removes the hazy fringe round the vehicle.
`site/bg-studio.js` is the newest background code (sharper turntable layout, quieter glass
reflection, and the "Lot, blurred" look); the worker uses it instead of the site's copy.

**2026-10-23:** turntable looks are laid out frame by frame: every frame is resized so the vehicle keeps
the same height, and its tyres land on the same spot of the platform (measured on a 50-frame walk-around:
tyre line steady to under 1 px, height to the measuring precision; before, the vehicle pulsed by up to
123 px and hopped by up to 75 px). The vehicle is sized to cover about 80% of the platform side-on. When part of the vehicle runs off the photo, the finished job says
how many photos that affected, so it can be recorded again from further back.

**Site publishing (2026-10-25):** `scripts/deploy_site.py` (run by the *Publish site files* workflow
whenever `site/bg-studio.js` or `site/guide-plus.js` change) sends those files to the live AutoSpin360
Worker on Cloudflare, keeping its photo bucket and every secret. It needs the `CF_API_TOKEN` secret
(Cloudflare API token with Workers Scripts: Edit); until that exists the workflow just says so.

`site/guide-plus.js` adds guide lines, a level, height/distance coaching and a pace check to the
guided camera's walk-around recording (loaded on the dealer admin page after `guide.js`).

