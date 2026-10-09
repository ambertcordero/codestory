"""Tests for backend/analyzer.py limits, filtering and ZIP handling."""

import io
import sys
import unittest
import zipfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import analyzer  # noqa: E402


def make_zip(entries):
    """Build an in-memory zip from [(name, bytes)] entries."""
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w", zipfile.ZIP_DEFLATED) as archive:
        for name, data in entries:
            archive.writestr(name, data)
    return buffer.getvalue()


def js_files(count, prefix="src/file"):
    return [(f"{prefix}{i}.js", b"const x = 1;\n") for i in range(count)]


class FileCountLimitTest(unittest.TestCase):
    def test_default_limit_is_ten_thousand(self):
        result = analyzer.analyze_files(js_files(10_000), "big")
        self.assertEqual(result["file_count"], 10_000)
        self.assertEqual(result["limits"]["max_file_count"], 10_000)

    def test_over_limit_raises_413(self):
        with self.assertRaises(analyzer.ImportValidationError) as ctx:
            analyzer.analyze_files(js_files(10_001), "big")
        self.assertEqual(ctx.exception.status_code, 413)
        self.assertIn("10", ctx.exception.message)

    def test_limit_is_configurable(self):
        options = {"max_file_count": 5}
        with self.assertRaises(analyzer.ImportValidationError):
            analyzer.analyze_files(js_files(6), "big", options=options)

    def test_below_300_still_works(self):
        result = analyzer.analyze_files(js_files(7), "small")
        self.assertEqual(result["file_count"], 7)


class DuplicateAndUnsafeTest(unittest.TestCase):
    def test_duplicate_paths_are_skipped_once(self):
        files = js_files(3) + [("src/file0.js", b"const y = 2;\n")]
        result = analyzer.analyze_files(files, "dup")
        self.assertEqual(result["file_count"], 3)
        self.assertEqual(result["skipped"]["duplicates"], ["src/file0.js"])

    def test_traversal_paths_are_unsafe(self):
        files = js_files(1) + [
            ("../evil.js", b"x"),
            ("src/../../evil2.js", b"x"),
            ("/abs.js", b"x"),
        ]
        result = analyzer.analyze_files(files, "unsafe")
        self.assertEqual(result["file_count"], 1)
        self.assertEqual(len(result["skipped"]["unsafe"]), 3)

    def test_dependency_and_generated_dirs_excluded(self):
        files = js_files(1) + [
            ("node_modules/react/index.js", b"x"),
            ("dist/bundle.js", b"x"),
            (".venv/lib/a.py", b"x"),
            ("__pycache__/m.cpython-311.pyc", b"x"),
            ("coverage/lcov-report/index.html", b"x"),
            ("src/main.js", b"x"),
        ]
        result = analyzer.analyze_files(files, "deps")
        self.assertEqual(result["file_count"], 2)
        self.assertEqual(len(result["skipped"]["dependencies"]), 2)
        self.assertIn("dist/bundle.js", result["skipped"]["generated"])

    def test_binary_and_unsupported_skipped(self):
        files = js_files(1) + [
            ("blob.js", b"\x00\x01\x02binary"),
            ("logo.png", b"\x89PNG\x00\x01"),
        ]
        result = analyzer.analyze_files(files, "bin")
        self.assertIn("blob.js", result["skipped"]["binary"])
        self.assertIn("logo.png", result["skipped"]["unsupported"])


class AnalyzeZipTest(unittest.TestCase):
    def test_roundtrip_streams_entries(self):
        entries = js_files(2500, prefix="proj/f")
        data = make_zip(entries)
        result = analyzer.analyze_zip(data, "proj.zip", with_content=True)
        self.assertEqual(result["file_count"], 2500)
        self.assertEqual(result["project_name"], "proj")

    def test_accepts_seekable_stream(self):
        data = make_zip(js_files(10))
        result = analyzer.analyze_zip(io.BytesIO(data), "s.zip")
        self.assertEqual(result["file_count"], 10)

    def test_oversize_entry_skipped_without_reading(self):
        entries = js_files(2) + [("src/big.js", b"x" * 500), ("ok.md", b"hi")]
        data = make_zip(entries)
        result = analyzer.analyze_zip(data, "z.zip", options={"max_file_size": 10})
        self.assertEqual(result["file_count"], 1)
        # All three files over 10 bytes are skipped without being read.
        self.assertEqual(
            result["skipped"]["too_large"],
            ["src/file0.js", "src/file1.js", "src/big.js"],
        )

    def test_bad_zip_rejected(self):
        with self.assertRaises(analyzer.ImportValidationError) as ctx:
            analyzer.analyze_zip(b"not a zip at all", "x.zip")
        self.assertEqual(ctx.exception.status_code, 400)

    def test_empty_zip_rejected(self):
        with self.assertRaises(analyzer.ImportValidationError):
            analyzer.analyze_zip(b"", "x.zip")

    def test_too_many_entries_rejected(self):
        entries = [(f"f{i}.txt", b"x") for i in range(analyzer.MAX_ZIP_ENTRIES + 1)]
        data = make_zip(entries)
        with self.assertRaises(analyzer.ImportValidationError) as ctx:
            analyzer.analyze_zip(data, "many.zip")
        self.assertEqual(ctx.exception.status_code, 413)

    def test_bomb_guard(self):
        original = analyzer.MAX_UNCOMPRESSED_SIZE
        try:
            analyzer.MAX_UNCOMPRESSED_SIZE = 10
            data = make_zip([("a.js", b"x" * 20)])
            with self.assertRaises(analyzer.ImportValidationError) as ctx:
                analyzer.analyze_zip(data, "bomb.zip")
            self.assertEqual(ctx.exception.status_code, 413)
        finally:
            analyzer.MAX_UNCOMPRESSED_SIZE = original

    def test_traversal_entries_unsafe(self):
        data = make_zip(js_files(1) + [("../evil.js", b"x")])
        result = analyzer.analyze_zip(data, "t.zip")
        self.assertEqual(result["skipped"]["unsafe"], ["../evil.js"])

    def test_duplicate_zip_entries_deduped(self):
        data = make_zip([("a.js", b"1"), ("a.js", b"2"), ("b.js", b"3")])
        result = analyzer.analyze_zip(data, "d.zip")
        self.assertEqual(result["file_count"], 2)
        self.assertEqual(result["skipped"]["duplicates"], ["a.js"])


if __name__ == "__main__":
    unittest.main()
