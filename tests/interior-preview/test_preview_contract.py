"""Source-contract checks for the browser-only interior preview-first path.

These checks deliberately avoid changing the existing editor/browser E2E suite.
Run from the repository root with: python -m unittest discover -s tests/interior-preview -v
"""
from pathlib import Path
import unittest

ROOT = Path(__file__).resolve().parents[2]
SHOWROOM = (ROOT / "site/showroom.js").read_text(encoding="utf-8")
TOUR = (ROOT / "site/tour.js").read_text(encoding="utf-8")
MEDIA_TOOLS = (ROOT / "site/media-tools.js").read_text(encoding="utf-8")
MEDIA_PAGE = (ROOT / "site/media.html").read_text(encoding="utf-8")


class InteriorPreviewContractTests(unittest.TestCase):
    def test_preview_is_positioned_inside_existing_pano_viewport(self):
        self.assertIn(".sr-pano .sr-preview{position:absolute; inset:0;", SHOWROOM)
        self.assertIn(".sr-pano canvas{position:absolute; inset:0;", SHOWROOM)
        self.assertIn("object-fit:cover", SHOWROOM)

    def test_preview_stays_until_panorama_setup_finishes(self):
        self.assertIn("root.classList.add('ready')", SHOWROOM)
        self.assertIn(".sr-pano.ready .sr-preview{display:none}", SHOWROOM)
        self.assertIn(".sr-pano.ready canvas{visibility:visible}", SHOWROOM)

    def test_failed_panorama_keeps_retry_action(self):
        self.assertIn("retry.textContent = 'Retry panorama'", SHOWROOM)
        self.assertIn("retry.addEventListener('click', () => { box.remove(); load(); })", SHOWROOM)
        self.assertIn("The panorama couldn’t be loaded. Please try again.", SHOWROOM)

    def test_new_interior_upload_creates_separate_preview_derivative(self):
        self.assertIn("const pb = await toBlob(pc, pickFormat(), 0.72)", MEDIA_TOOLS)
        self.assertIn("return { url: j.url, previewUrl, bytes: b.size", MEDIA_TOOLS)
        self.assertIn("previewUrl: r.previewUrl || ''", MEDIA_PAGE)

    def test_existing_records_remain_optional_preview_compatible(self):
        self.assertIn("(vehicle.interiorShots || []).find(okUrl) || ''", SHOWROOM)
        self.assertIn("(okUrl(list[i].previewUrl) ? list[i].previewUrl : ((v.interiorShots || []).find(okUrl) || ''))", TOUR)

    def test_tour_uses_same_preview_first_pano_component(self):
        self.assertIn("g.AS360Showroom.Pano(box, list[i].url", TOUR)
        self.assertIn("previewUrl:", TOUR)

    def test_no_crossfade_or_prefetch_was_added_to_preview_path(self):
        self.assertNotIn("transition:opacity", SHOWROOM[SHOWROOM.index(".sr-pano .sr-preview"):SHOWROOM.index(".sr-pctl")])
        self.assertNotIn("preload", SHOWROOM[SHOWROOM.index("function Pano("):SHOWROOM.index("/* ----- camera math")])

    def test_existing_reduced_motion_guard_remains(self):
        self.assertIn("if (!animate || REDUCED)", SHOWROOM)


if __name__ == "__main__":
    unittest.main()
