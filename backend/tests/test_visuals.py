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


def js_file(path: str, content: str) -> dict:
    return {
        "path": path,
        "language": "JavaScript",
        "content": content,
        "lines": content.count("\n") + 1,
        "size": len(content.encode("utf-8")),
    }


def edge_set(data: dict) -> set:
    return {(c["from"], c["to"], c["kind"]) for c in data["calls"]}


class CallGraphFixesTest(unittest.TestCase):
    """Regression coverage for review findings on the static call graph."""

    def test_variable_reuse_scopes_instance_bindings(self):
        source = """
class First {
  run() {}
}
class Second {
  run() {}
}
function a() {
  const obj = new First();
  obj.run();
}
function b() {
  const obj = new Second();
  obj.run();
}
"""
        data = visuals.build({"name": "reuse"}, [js_file("x.js", source)])
        edges = edge_set(data)
        self.assertIn(("x.js#a", "x.js#First.run", "call"), edges)
        self.assertIn(("x.js#b", "x.js#Second.run", "call"), edges)
        self.assertNotIn(("x.js#a", "x.js#Second.run", "call"), edges)
        self.assertNotIn(("x.js#b", "x.js#First.run", "call"), edges)

    def test_module_scope_binding_still_resolves_inside_functions(self):
        source = """
class Cart { add() {} }
const cart = new Cart();
function go() {
  cart.add();
}
"""
        data = visuals.build({"name": "scope"}, [js_file("x.js", source)])
        self.assertIn(("x.js#go", "x.js#Cart.add", "call"), edge_set(data))

    def test_default_import_calls_resolve(self):
        files = [
            js_file("a.js", "export default function start() { return 1; }\n"),
            js_file("b.js", "import start from './a.js';\nstart();\n"),
        ]
        data = visuals.build({"name": "default"}, files)
        edges = edge_set(data)
        self.assertTrue(any(to == "a.js#start" and kind == "call" for _f, to, kind in edges), edges)

    def test_named_import_still_resolves(self):
        files = [
            js_file("a.js", "export function helper() { return 1; }\n"),
            js_file("b.js", "import { helper } from './a.js';\nhelper();\n"),
        ]
        data = visuals.build({"name": "named"}, files)
        self.assertTrue(any(to == "a.js#helper" for _f, to, _k in edge_set(data)))

    def test_template_expression_calls_are_traced(self):
        source = """
function formatName(user) { return user.name; }
function label(user) {
  return `hello ${formatName(user)} and ${formatName({ name: 'x' })}`;
}
"""
        data = visuals.build({"name": "tpl"}, [js_file("x.js", source)])
        self.assertIn(("x.js#label", "x.js#formatName", "call"), edge_set(data))

    def test_stored_reference_is_not_a_flow_step(self):
        source = """
function draw() {}
const saved = draw;
register(draw);
"""
        data = visuals.build({"name": "refs"}, [js_file("x.js", source)])
        edges = edge_set(data)
        module = "x.js#(module)"
        self.assertIn((module, "x.js#draw", "callback"), edges)
        callback_lines = [c["line"] for c in data["calls"]
                          if c["to"] == "x.js#draw" and c["kind"] == "callback"]
        self.assertEqual(callback_lines, [4], data["calls"])

    def test_non_js_file_keeps_symbols_on_architecture_node(self):
        files = [{
            "path": "main.py", "language": "Python",
            "content": "def serve():\n    pass\n",
            "lines": 2, "size": 22,
        }]
        data = visuals.build({"name": "py"}, files)
        node = next(n for n in data["architecture"]["nodes"] if n["id"] == "main.py")
        names = [s["name"] for s in node["symbols"]]
        self.assertIn("serve", names)


class DomEvidenceTest(unittest.TestCase):
    """_dom_evidence only verifies real writes, not unrelated references."""

    LISTENER = "checkoutButton.addEventListener('click', checkout);\n"

    def build_module(self, body: str) -> visuals._Module:
        source = (
            "const checkoutButton = document.getElementById('checkoutButton');\n"
            "function checkout() {}\n"
            + body
            + self.LISTENER
        )
        module = visuals._Module("app.js", source)
        module.parse()
        return module

    def evidence_for(self, module: visuals._Module):
        trigger = {
            "file": "app.js",
            "line": module.content.count("\n"),
            "event": "click",
            "selectors": [],
        }
        render = module.symbols["app.js#renderCart"]
        return visuals._dom_evidence({render["id"]}, trigger, module.symbols, {"app.js": module})

    def test_unrelated_read_stays_inferred(self):
        module = self.build_module(
            "function renderCart() {\n  console.log(checkoutButton.disabled);\n}\n"
        )
        self.assertIsNone(self.evidence_for(module))

    def test_element_write_verifies(self):
        module = self.build_module(
            "function renderCart() {\n  checkoutButton.disabled = true;\n}\n"
        )
        evidence = self.evidence_for(module)
        self.assertIsNotNone(evidence)
        self.assertEqual(evidence["detail"], "updates checkoutButton")
        self.assertEqual(evidence["line"], 4)

    def test_innerHTML_write_verifies(self):
        module = self.build_module(
            "function renderCart() {\n  checkoutButton.innerHTML = '<b>x</b>';\n}\n"
        )
        self.assertIsNotNone(self.evidence_for(module))


if __name__ == "__main__":
    unittest.main()
