"""Checks visuals.build against the bundled Simple POS demo.

Run from the backend folder:  python -m unittest discover tests
"""

import pathlib
import sys
import unittest

BACKEND = pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0, str(BACKEND))

import visuals  # noqa: E402

DEMO = BACKEND.parent / "simple-pos-demo"
LANGUAGES = {".html": "HTML", ".css": "CSS", ".js": "JavaScript", ".md": "Markdown"}


def demo_files() -> list[dict]:
    files = []
    for path in sorted(DEMO.rglob("*")):
        if path.is_file() and path.suffix in LANGUAGES:
            content = path.read_text(encoding="utf-8")
            files.append({
                "path": path.relative_to(DEMO).as_posix(),
                "language": LANGUAGES[path.suffix],
                "content": content,
                "lines": content.count("\n") + 1,
                "size": len(content.encode("utf-8")),
            })
    return files


class SimplePosVisualsTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.files = demo_files()
        cls.lines = {f["path"]: f["content"].split("\n") for f in cls.files}
        cls.data = visuals.build({"name": "Simple POS System"}, cls.files)

    def line(self, path, number):
        return self.lines[path][number - 1]

    def test_architecture_edges_point_at_import_lines(self):
        edges = {(e["from"], e["to"]): e for e in self.data["architecture"]["edges"]}
        edge = edges[("js/app.js", "js/cart.js")]
        self.assertEqual(sorted(edge["names"]), ["Cart", "VAT_PERCENT"])
        self.assertIn("./cart.js", self.line("js/app.js", edge["line"]))
        self.assertIn(("js/cart.js", "js/products.js"), edges)

    def test_symbols_and_call_lines_match_source(self):
        symbols = self.data["symbols"]
        for symbol in symbols.values():
            if symbol["kind"] in ("function", "method"):
                self.assertIn(symbol["name"], self.line(symbol["file"], symbol["line"]))
        for call in self.data["calls"]:
            target = symbols[call["to"]]
            name = target.get("owner") if target["name"] == "constructor" else target["name"]
            self.assertIn(name, self.line(call["file"], call["line"]), call)

    def test_event_listeners_are_traced(self):
        elements = {entry.get("element") for entry in self.data["entries"]}
        self.assertTrue({"#productGrid", "#cartLines", "#checkoutButton", "#resetButton"} <= elements)

    def test_pos_journey_is_grounded(self):
        journey = self.data["journey"]
        titles = [stage["title"] for stage in journey["stages"]]
        self.assertEqual(titles, ["Products listed", "Product selected", "Cart updated",
                                  "Totals calculated", "Checkout", "Receipt generated"])
        for link in journey["links"]:
            self.assertTrue(link["verified"], link)
            self.assertIn(link["file"], self.lines)

    def test_missing_data_is_graceful(self):
        empty = visuals.build({"name": "Empty"}, [])
        self.assertIsNone(empty["journey"])
        self.assertEqual(empty["architecture"]["nodes"], [])

    def test_redaction(self):
        text = visuals.redact('const API_KEY = "abcd1234secret";')
        self.assertNotIn("abcd1234secret", text)


if __name__ == "__main__":
    unittest.main()
