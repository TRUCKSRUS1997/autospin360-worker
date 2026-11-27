# Interior preview-first loading

## Scope

This is a browser-only enhancement to the existing interior panorama display. It does not change the Worker, Cloudflare resources, original captures, or full panorama files. Existing vehicle records remain valid; preview metadata is optional.

## Behavior

- New interior-viewpoint uploads create a separate, derived preview image (up to 960 px wide) from the selected panorama. The original panorama upload remains the full-resolution 2:1 image used by the 360 viewer.
- The media editor stores the derived URL as optional `previewUrl` metadata on newly uploaded `interiorViews` records.
- The standalone vehicle panorama uses the first valid existing `interiorShots` photo as its preview when available.
- Older records without `previewUrl` continue to work. If an older record has an interior photo, that photo is used as the fallback preview; if it has none, the viewer retains its existing empty/loading background.
- The preview and WebGL canvas are absolutely positioned in the existing panorama viewport. The preview remains visible until the panorama has loaded, passed the equirectangular ratio check, and completed WebGL texture setup. The canvas then becomes visible in the same viewport.
- A panorama load or format failure leaves the preview visible and presents a retry control. Retrying requests the same panorama again; it does not change the saved vehicle record.
- The existing panorama camera, hotspots, gyro, touch/pointer handling, viewer controls and reduced-motion zoom guard are retained. No preview animation or crossfade is introduced.

## Files

- `site/media-tools.js`: generates and uploads the separate thumbnail derivative.
- `site/media.html`: stores its optional URL with newly uploaded interior viewpoints.
- `site/showroom.js`: renders the preview layer, swaps to the ready panorama, and provides retry.
- `site/tour.js`: supplies the preview URL to the shared panorama component.
- `tests/interior-preview/test_preview_contract.py`: source-contract regression checks.

`site/car.html` requires no change: it already passes the vehicle record and its `interiorShots` to the existing showroom attachment. The existing `tests/test_browser.py` and any editor E2E tests were not modified.

## Local checks

Run:

```bash
python -m unittest discover -s tests/interior-preview -v
```

The source-contract checks verify the structural preview/fallback/retry contract. They do not replace browser-level Playwright verification of image loading, viewport stability, mobile behavior, WebGL rendering, or interactive controls. Those browser checks remain required before considering this slice complete.

## Explicit non-goals

No Worker or Cloudflare changes; no deletion; no edits to original captures or full panoramas; no viewer reuse, prefetch, crossfades, seat arrows, or starting-heading changes; no deployment.
