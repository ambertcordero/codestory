"""CodeStory - backend/tests/test_story.py

Story-generation pipeline tests with a stubbed Ollama client (no real model
needed). Run from the backend directory:

    python3 -m unittest discover tests
"""

from __future__ import annotations

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import ollama  # noqa: E402
import story  # noqa: E402

FILES = [
    {
        "path": "index.js",
        "language": "JavaScript",
        "category": "Web",
        "size": 120,
        "lines": 4,
        "content": "function renderApp() {\n  return init();\n}\nfunction init() { return 1; }\n",
    },
    {
        "path": "README.md",
        "language": "Markdown",
        "category": "Docs",
        "size": 20,
        "lines": 1,
        "content": "# Demo project\n",
    },
]

RECORD = {"id": "t1", "name": "demo", "skipped": {}}

MODEL_JSON = (
    '{"title": "Demo", "overview": "A tiny app.", "chapters": ['
    '{"id": "c1", "title": "Entry", "narrative": "index.js renders.",'
    ' "how_it_works": "init returns 1.", "why_it_matters": "entry point",'
    ' "source_files": ["index.js"],'
    ' "evidence": [{"file": "index.js", "symbol": "renderApp", "snippet": "function renderApp"}],'
    ' "relationships": []},'
    '{"id": "c2", "title": "Docs", "narrative": "README documents.",'
    ' "how_it_works": "", "why_it_matters": "", "source_files": ["README.md"],'
    ' "evidence": [], "relationships": []}'
    "]}"
)


def _ok(text, model="test-model"):
    return {"ok": True, "model": model, "text": text, "error": None}


def _fail(error, status=None):
    return {"ok": False, "model": "test-model", "status": status, "error": error}


class _FakeOllama:
    """Patches ollama.generate, recording the requested formats."""

    def __init__(self, responses):
        self.responses = list(responses)
        self.formats = []
        self._real = ollama.generate

    def __enter__(self):
        def fake(prompt, model=None, timeout=300, response_format="json"):
            self.formats.append(response_format)
            return self.responses.pop(0)

        ollama.generate = fake
        return self

    def __exit__(self, *exc):
        ollama.generate = self._real


class GenerateTest(unittest.TestCase):
    def test_structured_story_is_grounded_and_saved_shape(self):
        with _FakeOllama([_ok(MODEL_JSON)]):
            result = story.generate(RECORD, FILES)
        self.assertTrue(result["structured"])
        self.assertEqual(len(result["chapters"]), 2)
        chapter = result["chapters"][0]
        self.assertEqual(chapter["title"], "Entry")
        self.assertIn("index.js", chapter["source_files"])
        self.assertEqual(chapter["evidence"][0]["file"], "index.js")
        self.assertTrue(chapter["evidence"][0]["snippet"])
        self.assertTrue(result["text"])

    def test_prose_response_falls_back_to_unstructured_text(self):
        with _FakeOllama([_ok("This is just prose, no JSON here.")]):
            result = story.generate(RECORD, FILES)
        self.assertFalse(result["structured"])
        self.assertEqual(result["chapters"], [])
        self.assertIn("prose", result["text"])
        self.assertTrue(result["note"])

    def test_empty_response_raises_clear_error(self):
        with _FakeOllama([_ok("")]):
            with self.assertRaises(story.StoryError) as ctx:
                story.generate(RECORD, FILES)
        self.assertIn("empty", ctx.exception.message.lower())

    def test_unreachable_ollama_raises_error_without_retry(self):
        with _FakeOllama([_fail("Could not reach Ollama.")]) as fake:
            with self.assertRaises(story.StoryError):
                story.generate(RECORD, FILES)
        self.assertEqual(len(fake.formats), 1)

    def test_http_error_retries_with_plain_json_format(self):
        with _FakeOllama([
            _fail("Ollama HTTP 400: invalid format value", status=400),
            _ok(MODEL_JSON),
        ]) as fake:
            result = story.generate(RECORD, FILES)
        self.assertTrue(result["structured"])
        self.assertEqual(len(fake.formats), 2)
        self.assertIs(fake.formats[0], story.STORY_RESPONSE_SCHEMA)
        self.assertEqual(fake.formats[1], "json")

    def test_missing_model_error_does_not_retry(self):
        with _FakeOllama([
            _fail("Ollama HTTP 404: model 'test-model' not found", status=404),
        ]) as fake:
            with self.assertRaises(story.StoryError) as ctx:
                story.generate(RECORD, FILES)
        self.assertEqual(len(fake.formats), 1)
        self.assertIn("not found", ctx.exception.message)


class OllamaStatusTest(unittest.TestCase):
    """status() must report availability for the exact model generate() sends."""

    def _status_with_models(self, installed, configured):
        real_request = ollama._request
        real_model = ollama._model
        try:
            ollama._model = lambda: configured
            ollama._request = lambda path, payload, timeout: {
                "models": [{"name": name} for name in installed]
            }
            return ollama.status()
        finally:
            ollama._request = real_request
            ollama._model = real_model

    def test_exact_tag_match_is_available(self):
        status = self._status_with_models(
            ["qwen2.5-coder:3b", "llama3:latest"], "qwen2.5-coder:3b")
        self.assertTrue(status["model_available"])

    def test_different_tag_is_not_available(self):
        status = self._status_with_models(
            ["qwen2.5-coder:7b"], "qwen2.5-coder:3b")
        self.assertFalse(status["model_available"])

    def test_untagged_model_resolves_to_latest(self):
        status = self._status_with_models(
            ["qwen2.5-coder:latest"], "qwen2.5-coder")
        self.assertTrue(status["model_available"])

    def test_untagged_model_missing_latest_tag(self):
        status = self._status_with_models(
            ["qwen2.5-coder:3b"], "qwen2.5-coder")
        self.assertFalse(status["model_available"])


class ParseResponseTest(unittest.TestCase):
    def test_parses_plain_json(self):
        self.assertEqual(story.parse_response('{"a": 1}'), {"a": 1})

    def test_parses_fenced_json(self):
        self.assertEqual(story.parse_response('text\n```json\n{"a": 1}\n```'), {"a": 1})

    def test_rejects_prose(self):
        self.assertIsNone(story.parse_response("no json at all"))

    def test_rejects_empty(self):
        self.assertIsNone(story.parse_response(""))


if __name__ == "__main__":
    unittest.main()
