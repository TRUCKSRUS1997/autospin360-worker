# Master recording and derived spin

Status: **client side only. Server-side items still need confirming (section 6).** Server upload is OFF by default.

## 1. What is kept
The guided camera records one walk-around video. Before, the video was discarded once the spin frames were cut out.
Now there are two separate things:

| | Master recording | Derived spin |
|---|---|---|
| What | The complete original video, byte for byte | The exterior photos the viewer shows |
| Changed by processing? | Never | Yes (regenerated, replaced) |
| Where | This device (IndexedDB `as360-master`), and the server once upload is turned on | Existing `/api/upload` photos, `exterior[]` |

Code: `site/master-recording.js` (`window.AS360Master`), hooked into `site/guide.js` (`opts.onMaster`) and `site/admin.html`.

## 2. How they are linked
- Each master has an id (`m...`). The vehicle record gets a new array `masterRecordings`, one entry per master:
  `{ id, schema, url, type, bytes, seconds, createdAt, kind, derivations[] }`.
- `derivations[]` lists every spin made from that master: `{ at, kind:"spin", method, synthetic:0, frames:[{ slot, t, source:"recorded", score, alternates:[t...] }] }`.
  `t` is the second in the master the frame came from. This is the provenance trail.
- `masterRecordings` is separate from `captures` (the 8-section clip flow), so it does not change the "x/8 clips" counts or the processor queue.
- Entries are only ever added. `link()` never replaces or drops an existing one, and reads the vehicle back to check the server kept it.

## 3. How the master is protected
- `keep()` adds the recording with IndexedDB `add`; an id that exists is refused. The stored bytes cannot be replaced through the module (`patch` only edits bookkeeping fields).
- Nothing deletes a master automatically: not processing, retry, regeneration or cleanup. `remove(id, {confirmed:true})` exists only for a person-confirmed removal of a copy already uploaded and linked, and refuses otherwise.
- The derived-photo cleanup in `admin.html` (`pendingDelete`) only ever holds photo URLs from `exterior[]`; masters are not in that list.
- Upload goes to the existing signed-in endpoint `POST /api/media?raw=1&role=master&vehicleId=...` (same one `capture.html` uses). It is never re-encoded: `upload-compress.js` only touches `/api/upload` and `/api/background`.
- After upload the client asks for the file **without** the sign-in cookie. If it opens, the master is flagged `exposure:"public"`, is **not** linked to the vehicle record, and the person is warned.

## 4. How frames are chosen (and what is not done)
- The recording is split into the same number of positions as before. For each position the code looks at 3 moments inside that position's slot, scores sharpness (edge energy) and exposure (too dark, too bright, clipped), and keeps the best. Moments flagged "part of the vehicle cut off" by the live fit check score lower. Frames stay in order so spacing stays even. If anything fails it falls back to the old even spacing.
- Every frame is a real moment of the recording (`source:"recorded"`). **Nothing is synthetic**, and the code has no way to make a synthetic frame.
- **Not implemented:** combining several frames to fill in a clipped area of one frame. That is image alignment and blending and was not attempted. The runner-up moments (`alternates`) are saved so it can be added later from real data.

## 5. Limits and cost assumptions
- Upload limit: 60 MB per file (existing `/api/media` limit). A longer or higher-bitrate master stays on the device only (`status:"too-large"`); it is never shrunk or re-encoded.
- Phone storage: masters stay until a person removes them, so repeated recordings use phone space. A list/remove screen is not built yet.
- Server cost, if turned on: up to 60 MB per master. 100 vehicles is at most about 6 GB; at object-storage list prices of roughly $0.015 per GB-month that is about $0.09 a month (check the real R2 plan). The existing storage budget screen counts it only if the server counts the file.
- **No retention rule exists and none was added.** What to keep, for how long, and who may delete, is a decision for the owner.

## 6. Retrieve and reprocess
- List: `AS360Master.list(vehicleId)`. Local bytes: `AS360Master.getBlob(id)`. Server copy: the entry's `url` (signed-in only).
- Reprocess: load the blob, run `AS360Master.selectFrames(video, count, opts)`, upload the frames, then `AS360Master.addDerivation(id, {...})`. The master is read only. (A button for this is not built yet.)
- Interrupted upload: the local copy stays; `AS360Master.sync(id)` or `resumePending(vehicleId)` (called when the vehicle editor opens) continues. A link is never duplicated.

## 7. Turning upload on (this browser only)
`localStorage.setItem('as360.masterUpload','1')` (or `AS360Master.setUploadEnabled(true)`). Do this first on the preview Worker, never on production, until the items below are confirmed.

## 8. Needs confirming on the server (not in this repository)
1. Files stored through `/api/media` are not readable without signing in. (The client checks this and refuses to link if they are.)
2. `PUT /api/vehicle` keeps an unknown array field `masterRecordings` and returns it. (The client checks this read-back.)
3. The public vehicle endpoint used by `car.html` does not return `masterRecordings` (it holds file addresses).
4. The storage tool "Move unused files to trash" / "Empty trash older than 7 days" counts files listed in `masterRecordings` as in use. If it does not, a master could be trashed and then deleted.
5. A retention policy (see section 5).
