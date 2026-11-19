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

**Site publishing (2026-11-19):** every file in `site/` is a copy of a file on the live AutoSpin360 site
(`/viewer.js`, `/index.html`, ...). Changing one here and merging to `main` publishes it to the live
Cloudflare Worker `autospin360`, in two steps: *Publish site files* first previews exactly what would change
(nothing is touched), then waits for **your approval** in GitHub before it backs up the live Worker,
publishes, checks the live site, and restores the backup by itself if a check fails.

- **Run it by hand:** Actions > *Publish site files* > Run workflow. "Dry run" (ticked by default) only previews.
- **Undo:** Actions > *Restore Worker backup* > Run workflow, with the number of the publish run (end of its web address).
  Cloudflare's own Deployments > Rollback button also works.
- **Safe by design:** only files in `site/` are added or replaced (never removed); the Worker's server code, R2 bucket,
  secrets and settings are carried over untouched; a file changed on the live site some other way stops the publish
  instead of being overwritten (`deploy/baseline.json` is the starting point, afterwards `/deploy-info.json` on the site).
- **Needed in GitHub (Settings):** secrets `CF_API_TOKEN` (Cloudflare API token, Workers Scripts: Edit) and
  `BACKUP_PASSPHRASE` (any long phrase; keep a copy in your password manager, it unlocks the backups);
  Environment `production` with you as required reviewer; variable `APPROVAL_GATE_READY` = `true` once that is done
  (until then nothing can publish).
- The Worker's server code is not in this repository (it is public); backups are encrypted for the same reason.

`site/guide-plus.js` adds guide lines, a level, height/distance coaching and a pace check to the
guided camera's walk-around recording (loaded on the dealer admin page after `guide.js`).

