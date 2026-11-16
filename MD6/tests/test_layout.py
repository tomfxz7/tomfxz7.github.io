"""Browser regressions for layout persistence and backups (no CDN access required).

Run: python3 -m unittest discover -s MD6/tests -v
Requires: pip install playwright; Chromium on PATH or CHROMIUM_PATH.
Only the cosmetic CDN scripts are replaced; application JS and IndexedDB are real.
Set HUB_TEST_ASSETS to a directory with hub.css and lucide.js to test real styling.
"""
import functools
import json
import os
from pathlib import Path
import shutil
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
import threading
import unittest

from playwright.sync_api import sync_playwright


ROOT = Path(__file__).resolve().parents[2]
APPS = [
    dict(id=key, name=name, createdAt=date, html=f"<h1>{name}</h1>")
    for key, name, date in [("a", "Zebra", 10), ("b", "Alpha", 30),
                            ("c", "Delta", 20), ("d", "Bravo", 40)]
]
# Stable geometry when cosmetic CDNs are unavailable. Real styles can be supplied.
TEST_CSS = """
.hidden { display: none !important; }
[data-lucide] { display: inline-block; width: 20px; height: 20px; }
#app-grid, #group-grid { display: grid; grid-template-columns: repeat(4, 150px); gap: 24px; }
.app-tile, #btn-add-app { width: 150px; height: 150px; box-sizing: border-box; position: relative; }
.tile-actions { position: absolute; top: 0; right: 0; }
#move-form, #move-stack-section { display: flex; flex-direction: column; gap: 12px; }
#move-modal > div { width: 100%; max-width: 360px; box-sizing: border-box; }
button { min-height: 30px; }
@media (max-width: 600px) { #app-grid, #group-grid { grid-template-columns: repeat(2, 150px); } }
#group-modal, #move-modal, #import-modal, #export-modal, #confirm-modal, #alert-modal, #editor-modal {
 position: fixed; inset: 0; background: white; z-index: 100; overflow: auto;
}
#move-modal { z-index: 110; } #confirm-modal, #alert-modal, #editor-modal { z-index: 120; }
"""


class QuietHandler(SimpleHTTPRequestHandler):
    def log_message(self, *_args):
        pass


class LayoutTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        handler = functools.partial(QuietHandler, directory=str(ROOT))
        cls.server = ThreadingHTTPServer(("127.0.0.1", 0), handler)
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()
        cls.url = f"http://127.0.0.1:{cls.server.server_port}/MD6/"
        cls.playwright = sync_playwright().start()
        executable = os.environ.get("CHROMIUM_PATH") or shutil.which("chromium") or shutil.which("google-chrome")
        cls.browser = cls.playwright.chromium.launch(
            executable_path=executable, headless=True, args=["--no-sandbox"])

    @classmethod
    def tearDownClass(cls):
        cls.browser.close()
        cls.playwright.stop()
        cls.server.shutdown()
        cls.server.server_close()

    def setUp(self):
        mobile = "mobile" in self._testMethodName
        self.context = self.browser.new_context(
            viewport={"width": 390 if mobile else 1280, "height": 844 if mobile else 900},
            is_mobile=mobile, has_touch=mobile, accept_downloads=True)
        assets = Path(os.environ["HUB_TEST_ASSETS"]) if os.environ.get("HUB_TEST_ASSETS") else None
        css = (assets / "hub.css").read_text() if assets else TEST_CSS
        icons = (assets / "lucide.js").read_text() if assets else "window.lucide = { createIcons() {} };"
        self.context.route("https://cdn.tailwindcss.com/**", lambda route: route.fulfill(
            content_type="application/javascript", body=""))
        self.context.route("https://unpkg.com/lucide@latest", lambda route: route.fulfill(
            content_type="application/javascript", body=icons))
        self.context.add_init_script("document.addEventListener('DOMContentLoaded', () => {"
                                     "const style = document.createElement('style');"
                                     f"style.textContent = {json.dumps(css)}; document.head.appendChild(style);"
                                     "});")
        self.page = self.context.new_page()
        self.errors = []
        self.page.on("pageerror", lambda error: self.errors.append(str(error)))
        self.page.goto(self.url)
        self.page.wait_for_selector("#btn-add-app")

    def tearDown(self):
        self.context.close()
        self.assertEqual(self.errors, [], "Unexpected browser JavaScript error")

    def seed(self, data=None, sort="custom"):
        self.page.evaluate("""async ({data, sort}) => {
          await idbSet('webapp_hub_data', data);
          localStorage.setItem('webapp_hub_sort', sort);
        }""", {"data": APPS if data is None else data, "sort": sort})
        self.page.reload()
        count = len(data["apps"]) if isinstance(data, dict) else len(APPS if data is None else data)
        self.page.wait_for_function("n => apps.length === n && document.querySelector('#btn-add-app')", arg=count)

    def ids(self, grid="#app-grid"):
        return self.page.locator(grid + " > [data-entry-id]").evaluate_all("nodes => nodes.map(n => n.dataset.entryId)")

    def state(self):
        return self.page.evaluate("async () => { await saveQueue; return await idbGet('webapp_hub_data'); }")

    def tile(self, id, grid="#app-grid"):
        return self.page.locator(f'{grid} > [data-entry-id="{id}"]')

    def drag(self, source, target, edge="center", grid="#app-grid"):
        dest = self.tile(target, grid)
        box = dest.bounding_box()
        x = box["width"] * {"before": .1, "center": .5, "after": .9}[edge]
        self.tile(source, grid).drag_to(dest, target_position={"x": x, "y": box["height"] * .55})
        self.state()

    def export(self, selected=None):
        self.page.locator("#btn-export").click()
        if selected is not None:
            cards = self.page.locator(".export-thumb")
            for index in range(cards.count()):
                if cards.nth(index).locator("input").input_value() not in selected:
                    cards.nth(index).click()
        with self.page.expect_download() as result:
            self.page.locator("#btn-export-confirm").click()
        return json.loads(Path(result.value.path()).read_text())

    def import_data(self, data, mode="overwrite"):
        self.page.locator("#import-file-input").set_input_files({
            "name": "backup.json", "mimeType": "application/json", "buffer": json.dumps(data).encode()})
        self.page.locator(f"#btn-import-{mode}").click()
        self.page.wait_for_selector("#import-modal", state="hidden")

    def test_drag_uses_visible_order_in_both_directions_and_survives_reload(self):
        self.seed(sort="name-asc")
        self.assertEqual(self.ids(), ["b", "d", "c", "a"])
        self.drag("a", "d", "before")
        self.assertEqual(self.ids(), ["b", "a", "d", "c"])
        self.assertEqual(self.page.locator("#sort-select").input_value(), "custom")
        self.drag("b", "c", "after")
        self.assertEqual(self.ids(), ["a", "d", "c", "b"])
        self.page.reload()
        self.page.wait_for_selector('[data-app-id="a"]')
        self.assertEqual(self.ids(), ["a", "d", "c", "b"])

    def test_stack_rename_move_out_and_ungroup(self):
        self.seed()
        self.drag("a", "b")
        group_id = self.state()["layout"]["groups"][0]["id"]
        self.assertEqual(self.ids(), [group_id, "c", "d"])
        self.drag("c", group_id)
        self.tile(group_id).click()
        self.assertEqual(self.ids("#group-grid"), ["b", "a", "c"])
        self.page.locator("#group-name").fill("仕事 & ツール")
        self.page.locator("#group-name-form button").click()
        self.drag("c", "b", "before", "#group-grid")
        self.assertEqual(self.ids("#group-grid"), ["c", "b", "a"])
        self.page.reload()
        self.page.wait_for_selector('[data-entry-type="group"]')
        self.tile(group_id).click()
        self.assertEqual(self.page.locator("#group-name").input_value(), "仕事 & ツール")
        self.tile("b", "#group-grid").locator(".btn-move").click()
        self.page.locator("#move-destination").select_option("")
        self.page.locator("#move-position").select_option("")
        self.page.locator("#move-form button").click()
        self.page.wait_for_selector("#move-modal", state="hidden")
        self.assertEqual(self.ids("#group-grid"), ["c", "a"])
        self.page.locator("#btn-ungroup").click()
        self.page.wait_for_selector("#group-modal", state="hidden")
        self.assertEqual(self.ids(), ["c", "a", "d", "b"])
        self.assertEqual(self.state()["layout"]["groups"], [])

    def test_backup_roundtrip_includes_layout_groups_and_sort(self):
        self.seed()
        self.drag("a", "b")
        self.page.locator("#sort-select").select_option("name-desc")
        backup = self.export()
        expected = self.ids()
        self.seed(data=[])
        self.import_data(backup)
        self.assertEqual(self.ids(), expected)
        self.assertEqual(self.state()["layout"], backup["layout"])
        self.assertEqual(self.page.locator("#sort-select").input_value(), "name-desc")
        self.page.reload()
        self.page.wait_for_selector('[data-entry-type="group"]')
        self.assertEqual(self.ids(), expected)

    def test_partial_export_and_repeated_append_remap_all_ids(self):
        self.seed()
        self.drag("a", "b")
        backup = self.export(selected=["a", "c"])
        self.assertEqual([a["id"] for a in backup["apps"]], ["a", "c"])
        self.assertEqual(backup["layout"]["groups"][0]["appIds"], ["a"])
        original_ids = self.ids()
        self.import_data(backup, "append")
        self.import_data(backup, "append")
        state = self.state()
        self.assertEqual(len(state["apps"]), 8)
        ids = [a["id"] for a in state["apps"]] + [g["id"] for g in state["layout"]["groups"]]
        self.assertEqual(len(ids), len(set(ids)))
        placed = [e["id"] for e in state["layout"]["home"] if e["type"] == "app"]
        placed += [id for g in state["layout"]["groups"] for id in g["appIds"]]
        self.assertCountEqual(placed, [a["id"] for a in state["apps"]])
        self.assertEqual(self.ids()[:len(original_ids)], original_ids)

    def test_legacy_import_restores_array_order_and_closes_stale_tabs(self):
        self.seed(sort="name-desc")
        self.tile("a").click()
        self.page.locator("#logo-home").click()
        self.import_data([APPS[2], APPS[0], APPS[1]])
        self.assertEqual(self.ids(), ["c", "a", "b"])
        self.assertEqual(self.page.locator("#sort-select").input_value(), "custom")
        self.assertEqual(self.page.locator("#iframe-manager iframe").count(), 0)

    def test_move_menu_works_with_keyboard_without_drag(self):
        self.seed()
        self.tile("d").locator(".btn-move").focus()
        self.page.keyboard.press("Enter")
        self.page.locator("#move-position").select_option(json.dumps({"type": "app", "id": "a"}, separators=(",", ":")))
        self.page.locator("#move-form button").focus()
        self.page.keyboard.press("Enter")
        self.page.wait_for_selector("#move-modal", state="hidden")
        self.assertEqual(self.ids(), ["d", "a", "b", "c"])
        self.tile("a").locator(".btn-move").click()
        self.page.locator("#move-stack-target").select_option("b")
        self.page.locator("#btn-move-stack").click()
        self.page.wait_for_selector("#move-modal", state="hidden")
        self.assertEqual(self.state()["layout"]["groups"][0]["appIds"], ["b", "a"])

    def test_invalid_backup_does_not_change_saved_data(self):
        self.seed()
        self.page.locator("#import-file-input").set_input_files({
            "name": "invalid.json", "mimeType": "application/json", "buffer": b'{"version": 2, "apps": [null]}'})
        self.page.wait_for_selector("#alert-modal", state="visible")
        self.assertEqual(self.ids(), ["a", "b", "c", "d"])
        self.assertEqual(self.state(), APPS)

    def test_mobile_touch_grouping_and_moving_every_member_home(self):
        self.seed()
        self.tile("a").locator(".btn-move").tap()
        self.page.locator("#move-stack-target").select_option("b")
        self.page.locator("#btn-move-stack").tap()
        self.page.wait_for_selector("#move-modal", state="hidden")
        group_id = self.state()["layout"]["groups"][0]["id"]
        self.tile(group_id).tap()
        for id in ["b", "a"]:
            self.tile(id, "#group-grid").locator(".btn-move").tap()
            self.page.locator("#move-destination").select_option("")
            self.page.locator("#move-position").select_option("")
            self.page.locator("#move-form button").tap()
            self.page.wait_for_selector("#move-modal", state="hidden")
        self.page.wait_for_selector("#group-modal", state="hidden")
        self.assertEqual(self.ids(), ["c", "d", "b", "a"])
        self.assertEqual(self.state()["layout"]["groups"], [])

    def test_deleting_group_member_removes_empty_folder_but_keeps_other_apps(self):
        self.seed()
        self.drag("a", "b")
        group_id = self.state()["layout"]["groups"][0]["id"]
        self.tile(group_id).click()
        for id in ["a", "b"]:
            self.tile(id, "#group-grid").locator(".btn-delete").click()
            self.page.locator("#btn-confirm-ok").click()
            self.page.wait_for_selector("#confirm-modal", state="hidden")
            self.state()
        self.page.wait_for_selector("#group-modal", state="hidden")
        self.assertEqual(self.ids(), ["c", "d"])
        self.assertEqual(self.state()["layout"]["groups"], [])


if __name__ == "__main__":
    unittest.main()
