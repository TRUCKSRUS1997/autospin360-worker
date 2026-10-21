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
