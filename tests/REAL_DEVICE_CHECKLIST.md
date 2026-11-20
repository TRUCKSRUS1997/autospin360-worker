# What the automated tests CANNOT tell you: checks for a real iPhone

Everything in `python tests/run_all.py` is **simulated**: headless Chromium on a computer, a fake camera that shows a
moving rectangle, fake motion-sensor readings, and made-up "cabin" scenes drawn by the test code. Those results are labelled
`[simulated]`. They prove the logic (maths, fallbacks, memory behaviour, screens) works. They do **not** prove anything about
an iPhone's lens, sensors, speed or memory. Please run the items below on the preview address and report what you see.

## A. Speed and memory (5 minutes)
1. Open `/pano-bench.html` on the iPhone (preview address). Tap **Start the test**. Keep the screen on.
2. When it ends, tap **Copy results** and send them over. If Safari reloads part-way, open the page again: it will say which size was too much.
   This tells us the real safe photo size and picture size for your phone model. Until then the app assumes a modest phone: photos kept at up to 2560 px.

## B. Camera and lens (needs one real capture)
1. Media page > a vehicle > Interior > **Capture with phone** > Start. Allow camera and motion access.
2. Top of the screen should say **0.5× ultra-wide lens**. If it says "Main lens", tap **Lens** and see which cameras are listed (the list names are what Safari reports). Tell me the exact names.
3. Open **Advanced** on the review screen and tap **Copy details**: it records the camera name, picture size the camera really gave, whether exposure could be locked, motion-sensor rate, timings. Send it over.

## C. Motion sensors
1. Does the first run ask for motion access? Is anything refused or silent? (If yes, manual mode should offer itself.)
2. Turn slowly on the spot. Do the dots stay where the real world is, or do they slide? (Slide = compass drift.)
3. Hold the phone sideways (landscape) for a few photos. Do the dots still match, and does the final picture come out upright?
4. Look straight up and straight down. Do the dots at the top and bottom behave?

## D. Result quality (the part only your eyes can judge)
1. Turn on the spot with the phone close to your body (arms in), versus holding it out at arm's length. Compare the seams around the steering wheel, dash, seats and windows. (Close-range parallax cannot be fixed by software; the app shows an "alignment" word: good / fair / poor.)
2. Is the "Lens view" auto-fit sensible (Advanced > Lens view)? If straight edges look bent where photos meet, say what number looked right.
3. Zoom into the final picture in the showroom viewer: is it sharp at 100%?
4. Time the "Saving the panorama" step. Longer than about 45 s means the app should pick a smaller size for that phone.

## E. Existing features still work (regression)
Exterior spin viewer, inventory page, the old "Add panorama file" button, photo gallery, videos, background studio.

## Added after review (alignment and speed-test limits)
- On a real cabin capture, the review screen should say alignment is good or fair. If it says "NOT verified" or "poor", note the car and light conditions: that is the safety warning working, and the capture should be retaken with more overlap.
- The "% covered" figure is now calculated after alignment, so it can be lower than before; compare it with the picture itself.
- The speed test (/pano-bench.html) measures made-up-image stitching only, not camera capture, JPEG encoding or final image quality. Real captures take longer.

## F. Stage A: original photos kept on the phone (needs a real iPhone; nothing here is proven by the simulated tests)
Run on the PREVIEW address only. Use a test vehicle, never a customer vehicle record.
1. **Delivered size.** At the top of the capture screen the green line says what size originals are kept at, e.g. "4032×3024 JPEG 95". Write it down. If it says 1920×1440 the camera did not give the larger size; if it says REDUCED, note the reason shown. (Safari's real behaviour is unknown until you look.)
2. **One panorama, start to finish.** Note: number of photos kept, the MB shown in the "Saved originals" list, how long each photo takes to save (does the shutter feel slower?), whether the phone warms up, whether the page ever reloads by itself.
3. **Storage.** After capture, reopen the capture screen: it lists the session with its size. Note the "free space" warning if one appeared. Does it say storage is persistent? (Safari may refuse; a refusal is a result, not a failure.)
4. **Save a copy (the important one).** Tap "Prepare the file", then "Save or share", save to Files, then "Check the saved copy" and pick the file you saved. It must say Confirmed. Open the zip on a computer: the photos should open and look sharp. Note the zip size.
5. **Interruption.** Start a capture, take about 10 photos, then (a) press the side button to lock the phone for 30 s, (b) switch to another app for a minute, (c) separately: force-quit Safari. After each, reopen the capture screen: is the unfinished session listed with the right photo count? Does "Recover into a panorama" work? (Continuing to capture after a recovery is NOT built; only recovery.)
6. **Eviction (slow).** Leave a session on the phone, without saving a copy, for 8 days of normal use without opening this site. Is it still listed? This is how to find out whether Safari clears it. Do not rely on local storage for anything you can't re-shoot.
7. **Storage full.** Only if you can: fill the phone to a few hundred MB free, start a capture. The "no more room" screen should appear with three choices.
8. **Delete.** Delete one saved session from the list. It should ask, show the photo count and MB, and warn if no checked copy exists.
9. **Panorama quality.** Compare a Stage A panorama with one from the previous version of the same car and seat: sharpness at 100% in the viewer, any colour or blocky artifacts.
