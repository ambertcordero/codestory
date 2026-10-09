"""CodeStory - backend/story.py

Structured, chapter-based story generation for imported projects, powered by the
configured local Ollama model.

The model is asked for a JSON document that references only the files and
symbols it was shown. The response is then grounded against the stored project:

* file references are resolved to real files,
* code evidence is replaced with source text extracted from disk,
* line numbers are attached only when they can be computed reliably,
* relationships are checked against the static-analysis reference graph and
  labelled verified or potential.

If the model does not return usable structured output, generation falls back to
the raw response text so the existing markdown Story renderer can display it.
Nothing here executes the imported code or contacts anything other than the
configured local Ollama endpoint.
"""

from __future__ import annotations

import json
import posixpath
import re
from datetime import datetime, timezone

import ollama
import static_analysis
import visuals

# Safety bound only: chapter count should come from the project, not a
# fixed limit. This just guards against a runaway model response.
SAFETY_CHAPTER_CAP = 40
MAX_EVIDENCE_PER_CHAPTER = 4
MAX_RELATIONSHIPS_PER_CHAPTER = 6
MAX_SYMBOLS_PER_FILE = 24
MAX_VERIFIED_ISSUES = 12
SNIPPET_MAX_LINES = 14
SNIPPET_MAX_CHARS = 1400

PROMPT_SOURCE_BUDGET = 40_000
PROMPT_FILE_SNIPPET_CHARS = 3_500
CHAPTER_SOURCE_BUDGET = 24_000

STORY_RESPONSE_SCHEMA = {
    "type": "object",
    "properties": {
        "title": {"type": "string"},
        "overview": {"type": "string"},
        "chapters": {
            "type": "array",
            "minItems": 1,
            "items": {
                "type": "object",
                "properties": {
                    "id": {"type": "string"},
                    "title": {"type": "string"},
                    "narrative": {"type": "string"},
                    "how_it_works": {"type": "string"},
                    "why_it_matters": {"type": "string"},
                    "source_files": {"type": "array", "items": {"type": "string"}},
                    "evidence": {
                        "type": "array",
                        "items": {
                            "type": "object",
                            "properties": {
                                "file": {"type": "string"},
                                "symbol": {"type": "string"},
                                "snippet": {"type": "string"},
                            },
                            "required": ["file", "symbol", "snippet"],
                            "additionalProperties": False,
                        },
                    },
                    "relationships": {
                        "type": "array",
                        "items": {
                            "type": "object",
                            "properties": {
                                "from": {"type": "string"},
                                "to": {"type": "string"},
                                "description": {"type": "string"},
                            },
                            "required": ["from", "to", "description"],
                            "additionalProperties": False,
                        },
                    },
                },
                "required": [
                    "id", "title", "narrative", "how_it_works", "why_it_matters",
                    "source_files", "evidence", "relationships",
                ],
                "additionalProperties": False,
            },
        },
    },
    "required": ["title", "overview", "chapters"],
    "additionalProperties": False,
}

# Incremental pass for projects whose full source does not fit one prompt:
# an outline first, then one detail request per chapter.
OUTLINE_RESPONSE_SCHEMA = {
    "type": "object",
    "properties": {
        "title": {"type": "string"},
        "overview": {"type": "string"},
        "chapters": {
            "type": "array",
            "minItems": 1,
            "items": {
                "type": "object",
                "properties": {
                    "id": {"type": "string"},
                    "title": {"type": "string"},
                    "summary": {"type": "string"},
                    "source_files": {"type": "array", "items": {"type": "string"}},
                },
                "required": ["id", "title", "summary", "source_files"],
                "additionalProperties": False,
            },
        },
    },
    "required": ["title", "overview", "chapters"],
    "additionalProperties": False,
}

CHAPTER_RESPONSE_SCHEMA = {
    "type": "object",
    "properties": {
        "narrative": {"type": "string"},
        "how_it_works": {"type": "string"},
        "why_it_matters": {"type": "string"},
        "evidence": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "file": {"type": "string"},
                    "symbol": {"type": "string"},
                    "snippet": {"type": "string"},
                },
                "required": ["file", "symbol", "snippet"],
                "additionalProperties": False,
            },
        },
        "relationships": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "from": {"type": "string"},
                    "to": {"type": "string"},
                    "description": {"type": "string"},
                },
                "required": ["from", "to", "description"],
                "additionalProperties": False,
            },
        },
    },
    "required": ["narrative", "how_it_works", "why_it_matters", "evidence", "relationships"],
    "additionalProperties": False,
}


class StoryError(Exception):
    """Raised when the local model cannot generate a story."""

    def __init__(self, message: str):
        super().__init__(message)
        self.message = message


# --------------------------------------------------------------------------- #
# Symbol extraction (static, best-effort)
# --------------------------------------------------------------------------- #

_JS_PATTERNS = [
    (re.compile(r"^\s{0,6}(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\("), "function"),
    (re.compile(r"^\s{0,6}(?:export\s+)?class\s+([A-Za-z_$][\w$]*)"), "class"),
    (re.compile(
        r"^\s{0,6}(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*"
        r"(?:async\s*)?(?:function\b|\([^)]*\)\s*=>|[A-Za-z_$][\w$]*\s*=>)"
    ), "function"),
    (re.compile(r"^\s{2,}([A-Za-z_$][\w$]*)\s*\([^;{]*\)\s*\{"), "method"),
]

_PY_PATTERNS = [
    (re.compile(r"^class\s+(\w+)"), "class"),
    (re.compile(r"^\s*def\s+(\w+)\s*\("), "function"),
]

_RESERVED_SYMBOLS = {
    "if", "for", "while", "switch", "catch", "return", "else", "do", "try",
    "function", "constructor", "super", "await", "new", "typeof", "with",
}


def extract_symbols(content: str, language: str) -> list[dict]:
    """Return best-effort symbols with reliable 1-based line numbers."""
    if language in ("JavaScript", "TypeScript", "JavaScript (JSX)", "TypeScript (TSX)"):
        patterns = _JS_PATTERNS
    elif language == "Python":
        patterns = _PY_PATTERNS
    else:
        return []

    lines = content.splitlines()
    found: list[dict] = []
    seen: set[str] = set()
    for index, line in enumerate(lines):
        for pattern, kind in patterns:
            match = pattern.match(line)
            if not match:
                continue
            name = match.group(1)
            if name in _RESERVED_SYMBOLS or name in seen:
                break
            seen.add(name)
            found.append({"name": name, "kind": kind, "line": index + 1})
            break
        if len(found) >= MAX_SYMBOLS_PER_FILE:
            break
    return found


# --------------------------------------------------------------------------- #
# Snippets
# --------------------------------------------------------------------------- #

def _dedent(lines: list[str]) -> list[str]:
    indents = [len(line) - len(line.lstrip()) for line in lines if line.strip()]
    strip = min(indents) if indents else 0
    return [line[strip:] if len(line) >= strip else line for line in lines]


def _clip(text: str, max_lines: int = SNIPPET_MAX_LINES) -> str:
    lines = text.splitlines()
    if len(lines) > max_lines:
        lines = lines[:max_lines]
    clipped = "\n".join(lines)
    if len(clipped) > SNIPPET_MAX_CHARS:
        clipped = clipped[:SNIPPET_MAX_CHARS]
    return clipped.rstrip()


def snippet_for_lines(content: str, start_line: int, max_lines: int = SNIPPET_MAX_LINES) -> str:
    """Return a real snippet starting at a 1-based line number."""
    lines = content.splitlines()
    if start_line < 1 or start_line > len(lines):
        return ""
    return _clip("\n".join(_dedent(lines[start_line - 1:start_line - 1 + max_lines])))


def line_of_snippet(content: str, snippet: str) -> int | None:
    """Return the 1-based line where a snippet begins, or None if not found."""
    if not snippet.strip():
        return None
    hay = content.replace("\r\n", "\n").splitlines()
    needle = [line.strip() for line in snippet.replace("\r\n", "\n").splitlines() if line.strip()]
    if not needle:
        return None
    hay_stripped = [line.strip() for line in hay]
    first = needle[0]
    for start, value in enumerate(hay_stripped):
        if value != first:
            continue
        matched = sum(
            1 for offset, token in enumerate(needle)
            if start + offset < len(hay_stripped) and hay_stripped[start + offset] == token
        )
        if matched >= max(2, len(needle) - 1):
            return start + 1
    return None


# --------------------------------------------------------------------------- #
# Prompt
# --------------------------------------------------------------------------- #

def _as_text(value) -> str:
    if value is None:
        return ""
    if isinstance(value, (list, tuple)):
        return "\n".join(str(item) for item in value if item is not None)
    return str(value)


def build_prompt(record: dict, files: list[dict], relationships: list[dict], issues: list[dict]) -> str:
    """Assemble the grounding catalogue plus source code for the model."""
    catalogue = []
    for item in files:
        symbols = extract_symbols(item.get("content", ""), item.get("language", ""))
        symbol_text = ", ".join(f"{symbol['name']} (line {symbol['line']})" for symbol in symbols) or "none detected"
        catalogue.append(
            f"- {item['path']} ({item.get('language', 'file')}, "
            f"{len(item.get('content', '').splitlines())} lines): {symbol_text}"
        )

    reference_lines = [
        f"- {edge.get('from')} references {edge.get('to')}" for edge in relationships
    ] or ["- no cross-file references detected"]

    issue_lines = []
    for finding in issues:
        location = ""
        if finding.get("file"):
            location = f" ({finding['file']}{':' + str(finding['line']) if finding.get('line') else ''})"
        issue_lines.append(f"- [{finding.get('severity', 'info')}] {finding.get('title', '')}{location}")
    if not issue_lines:
        issue_lines = ["- no static-analysis findings"]

    header = (
        "You are a storyteller turning a real codebase into a narrative that plays "
        "out like the software running in real life.\n"
        "Explain ONLY what the source code below actually shows. Never invent files, "
        "symbols, functions, classes, variables or relationships.\n\n"
        "Return a single JSON object and NOTHING else (no markdown fences, no prose "
        "before or after). Use this exact shape:\n"
        "{\n"
        '  "title": "project title",\n'
        '  "overview": "one short paragraph introducing the cast and the world of this app",\n'
        '  "chapters": [\n'
        "    {\n"
        '      "id": "chapter-1",\n'
        '      "title": "Chapter title",\n'
        '      "narrative": "a scene: real people using this part of the app, in order",\n'
        '      "how_it_works": "optional: the flow between components",\n'
        '      "why_it_matters": "optional: the role of this part",\n'
        '      "source_files": ["path/from/the/list"],\n'
        '      "evidence": [{"file": "path/from/the/list", "symbol": "existing symbol name or empty", "snippet": "copy a few real lines verbatim"}],\n'
        '      "relationships": [{"from": "file or symbol", "to": "file or symbol", "description": "what the link means"}]\n'
        "    }\n"
        "  ]\n"
        "}\n\n"
        "Rules:\n"
        "- Order the chapters to follow how the app actually runs: how it starts, each "
        "main user flow in the order it happens, and how a run ends. Reading chapter "
        "1 to the last should feel like watching the whole system work once.\n"
        "- Write each narrative as a SCENE: name the real people who would use this "
        "part (a cashier and customer for a POS, a guest and receptionist for a "
        "booking app, a developer for a CLI, a client app for an API) and narrate "
        "what they do and what the code does in response. Pick personas only where "
        "the code clearly supports them.\n"
        "- Keep narratives pure prose: NO code, NO syntax, NO inline fragments. "
        "Real code only ever appears in 'evidence' snippets.\n"
        "- Create as many chapters as the project actually needs to explain it end to "
        "end. A small app may need 4-6; a larger system needs more. Do not pad with "
        "filler and do not merge unrelated concerns just to shorten the list.\n"
        "- Include one final chapter about verified issues and possible improvements.\n"
        "- Every file you mention MUST appear in the file list below.\n"
        "- Every symbol you mention SHOULD appear in the symbol list for that file.\n"
        "- Copy evidence snippets VERBATIM from the source shown; do not paraphrase code.\n"
        "- Only claim relationships the reference list supports; otherwise call them possible.\n"
        "- Distinguish verified findings from suggestions. Do not claim bugs or security issues without evidence.\n"
        "- Keep the JSON valid: double quotes, no trailing commas, no comments.\n\n"
        f"Project name: {record.get('name', 'Untitled')}\n"
        f"Files: {len(files)}\n\n"
        "File list and detected symbols:\n"
        + "\n".join(catalogue) + "\n\n"
        "Verified cross-file references (static analysis — the traced flows):\n"
        + "\n".join(reference_lines) + "\n\n"
        "Verified static-analysis findings:\n"
        + "\n".join(issue_lines) + "\n\n"
        "Source code:\n"
    )

    budget = PROMPT_SOURCE_BUDGET
    blocks: list[str] = []
    shown: set[str] = set()
    for item in files:
        snippet = item.get("content", "")
        if len(snippet) > PROMPT_FILE_SNIPPET_CHARS:
            snippet = snippet[:PROMPT_FILE_SNIPPET_CHARS] + "\n... (truncated)"
        block = f"### File: {item['path']}\n```\n{snippet}\n```\n"
        if budget - len(block) < 0:
            break
        budget -= len(block)
        blocks.append(block)
        shown.add(item["path"])
    return header + "\n".join(blocks), shown


def _chapter_prompt(record: dict, outline_chapter: dict, chapter_files: list[dict], relationships: list[dict]) -> str:
    """Prompt for one chapter of an incrementally generated story."""
    catalogue = []
    for item in chapter_files:
        symbols = extract_symbols(item.get("content", ""), item.get("language", ""))
        symbol_text = ", ".join(f"{symbol['name']} (line {symbol['line']})" for symbol in symbols) or "none detected"
        catalogue.append(f"- {item['path']} ({item.get('language', 'file')}): {symbol_text}")

    header = (
        "You are a storyteller turning a real codebase into a narrative that plays "
        "out like the software running in real life.\n"
        "Write ONE chapter of a larger story. Explain ONLY what the source code below "
        "actually shows. Never invent files, symbols or relationships.\n\n"
        "Return a single JSON object and NOTHING else with this shape:\n"
        "{\n"
        '  "narrative": "a scene: real people using this part of the app, in order",\n'
        '  "how_it_works": "the flow between components",\n'
        '  "why_it_matters": "the role of this part",\n'
        '  "evidence": [{"file": "path/from/the/list", "symbol": "existing symbol name or empty", "snippet": "copy a few real lines verbatim"}],\n'
        '  "relationships": [{"from": "file or symbol", "to": "file or symbol", "description": "what the link means"}]\n'
        "}\n\n"
        "Rules:\n"
        "- Write the narrative as a SCENE: name the real people who would use this "
        "part and narrate what they do and what the code does in response.\n"
        "- Keep the narrative pure prose: NO code, NO syntax, NO inline fragments. "
        "Real code only ever appears in 'evidence' snippets.\n"
        "- Every file you mention MUST appear in the file list below.\n"
        "- Copy evidence snippets VERBATIM from the source shown.\n"
        "- Keep the JSON valid: double quotes, no trailing commas, no comments.\n\n"
        f"Project name: {record.get('name', 'Untitled')}\n"
        f"Chapter title: {outline_chapter.get('title', '')}\n"
        f"Chapter summary: {outline_chapter.get('summary', '')}\n\n"
        "Chapter file list and detected symbols:\n"
        + "\n".join(catalogue) + "\n\n"
        "Verified cross-file references involving these files:\n"
        + ("\n".join(
            f"- {edge.get('from')} references {edge.get('to')}" for edge in relationships
        ) or "- none detected") + "\n\n"
        "Source code:\n"
    )

    budget = CHAPTER_SOURCE_BUDGET
    blocks: list[str] = []
    for item in chapter_files:
        snippet = item.get("content", "")
        if len(snippet) > PROMPT_FILE_SNIPPET_CHARS:
            snippet = snippet[:PROMPT_FILE_SNIPPET_CHARS] + "\n... (truncated)"
        block = f"### File: {item['path']}\n```\n{snippet}\n```\n"
        if budget - len(block) < 0:
            break
        budget -= len(block)
        blocks.append(block)
    return header + "\n".join(blocks)


def _outline_prompt(record: dict, files: list[dict], relationships: list[dict], issues: list[dict]) -> str:
    """Prompt that asks the model to plan the chapter structure from the catalogue."""
    catalogue = []
    for item in files:
        symbols = extract_symbols(item.get("content", ""), item.get("language", ""))
        symbol_text = ", ".join(symbol["name"] for symbol in symbols[:10]) or "none detected"
        catalogue.append(
            f"- {item['path']} ({item.get('language', 'file')}, "
            f"{len(item.get('content', '').splitlines())} lines): {symbol_text}"
        )
    reference_lines = [
        f"- {edge.get('from')} references {edge.get('to')}" for edge in relationships
    ] or ["- no cross-file references detected"]
    return (
        "You are a storyteller planning a scene-based story of a real codebase.\n"
        "The project is too large to show every file in full, so use the complete file "
        "list and symbol catalogue below to decide which chapters the story needs.\n\n"
        "Return a single JSON object and NOTHING else with this shape:\n"
        "{\n"
        '  "title": "project title",\n'
        '  "overview": "one short paragraph grounded in the catalogue",\n'
        '  "chapters": [{"id": "chapter-1", "title": "Chapter title", "summary": "what this chapter will explain", "source_files": ["paths/from/the/list"]}]\n'
        "}\n\n"
        "Rules:\n"
        "- Choose as many chapters as the project needs to explain it end to end: "
        "purpose, entry points, key components, workflows, business rules, "
        "integrations, and a final chapter on verified issues and improvements.\n"
        "- Order the chapters to follow how the app actually runs: how it starts, "
        "each main user flow in the order it happens, and how a run ends.\n"
        "- Every source_files entry MUST come from the file list below.\n"
        "- Do not invent files, modules or features that are not in the catalogue.\n"
        "- Keep the JSON valid: double quotes, no trailing commas, no comments.\n\n"
        f"Project name: {record.get('name', 'Untitled')}\n"
        f"Files: {len(files)}\n\n"
        "Complete file list and detected symbols:\n"
        + "\n".join(catalogue) + "\n\n"
        "Verified cross-file references (static analysis):\n"
        + "\n".join(reference_lines) + "\n"
    )


# --------------------------------------------------------------------------- #
# Response parsing
# --------------------------------------------------------------------------- #

def parse_response(text: str) -> dict | None:
    """Safely extract the first JSON object from a model response."""
    if not text:
        return None
    cleaned = text.strip()
    try:
        parsed = json.loads(cleaned)
    except json.JSONDecodeError:
        parsed = None
    if isinstance(parsed, dict):
        return parsed

    fence = re.search(r"```(?:json)?\s*(.*?)```", cleaned, re.DOTALL | re.IGNORECASE)
    if fence:
        cleaned = fence.group(1).strip()

    start = cleaned.find("{")
    if start == -1:
        return None

    depth = 0
    in_string = False
    escaped = False
    for index in range(start, len(cleaned)):
        char = cleaned[index]
        if in_string:
            if escaped:
                escaped = False
            elif char == "\\":
                escaped = True
            elif char == '"':
                in_string = False
            continue
        if char == '"':
            in_string = True
        elif char == "{":
            depth += 1
        elif char == "}":
            depth -= 1
            if depth == 0:
                try:
                    parsed = json.loads(cleaned[start:index + 1])
                except json.JSONDecodeError:
                    return None
                return parsed if isinstance(parsed, dict) else None
    return None


# --------------------------------------------------------------------------- #
# Grounding / validation
# --------------------------------------------------------------------------- #

class _Grounding:
    def __init__(self, files: list[dict]):
        self.by_path = {item["path"]: item for item in files}
        self.by_base: dict[str, set[str]] = {}
        for path in self.by_path:
            self.by_base.setdefault(posixpath.basename(path), set()).add(path)
        self.symbols: dict[str, set[str]] = {}
        self.snippets: dict[str, dict] = {}
        for item in files:
            path = item["path"]
            content = item.get("content", "")
            per_file: dict = {}
            for symbol in extract_symbols(content, item.get("language", "")):
                per_file[symbol["name"]] = (snippet_for_lines(content, symbol["line"]), symbol["line"])
                self.symbols.setdefault(symbol["name"], set()).add(path)
            head = _clip(content, max_lines=10)
            per_file["__head__"] = (head, 1 if head else None)
            self.snippets[path] = per_file

    def resolve_file(self, value) -> str | None:
        if not isinstance(value, str):
            return None
        candidate = value.strip().replace("\\", "/")
        while candidate.startswith("./"):
            candidate = candidate[2:]
        if not candidate:
            return None
        if candidate in self.by_path:
            return candidate
        base = posixpath.basename(candidate)
        matches = self.by_base.get(base)
        if matches and len(matches) == 1:
            return next(iter(matches))
        suffix_matches = [
            path for path in self.by_path
            if path.endswith("/" + candidate) or candidate.endswith("/" + path)
        ]
        return suffix_matches[0] if len(suffix_matches) == 1 else None

    def resolve_endpoint(self, value) -> tuple[str | None, str | None]:
        if not isinstance(value, str):
            return None, None
        token = value.strip()
        if not token:
            return None, None
        path = self.resolve_file(token)
        if path:
            return path, None
        tail = token.split("(")[0].split(".")[-1].strip()
        paths = self.symbols.get(tail) or self.symbols.get(token)
        if paths and len(paths) == 1:
            return next(iter(paths)), tail if tail in self.symbols else token
        return None, None

    def content(self, path: str) -> str:
        return self.by_path.get(path, {}).get("content", "")


def _build_evidence(raw_evidence, grounding: _Grounding, chapter_files: set[str]) -> list[dict]:
    evidence = []
    seen: set[tuple] = set()
    for entry in raw_evidence or []:
        if not isinstance(entry, dict):
            continue
        path = grounding.resolve_file(entry.get("file"))
        if not path:
            continue
        content = grounding.content(path)
        if not content.strip():
            continue

        symbol = entry.get("symbol")
        symbol = symbol.strip() if isinstance(symbol, str) else ""
        if symbol and symbol not in grounding.snippets.get(path, {}):
            symbol = ""

        snippet = ""
        line = None
        if symbol:
            snippet, line = grounding.snippets[path][symbol]
        else:
            raw = _as_text(entry.get("snippet")).strip()
            if raw:
                found = line_of_snippet(content, raw)
                if found:
                    snippet = _clip(raw)
                    line = found
            if not snippet:
                snippet, line = grounding.snippets[path]["__head__"]
        if not snippet:
            continue

        key = (path, symbol, line)
        if key in seen:
            continue
        seen.add(key)
        evidence.append({"file": path, "symbol": symbol, "line": line, "snippet": visuals.redact(snippet), "grounded": True})
        chapter_files.add(path)
        if len(evidence) >= MAX_EVIDENCE_PER_CHAPTER:
            break
    return evidence


def _build_relationships(raw_relationships, grounding: _Grounding, edge_lookup: set) -> list[dict]:
    relationships = []
    seen: set[tuple] = set()
    for entry in raw_relationships or []:
        if not isinstance(entry, dict):
            continue
        from_file, from_symbol = grounding.resolve_endpoint(entry.get("from"))
        to_file, to_symbol = grounding.resolve_endpoint(entry.get("to"))
        if not from_file or not to_file:
            continue
        verified = not from_symbol and not to_symbol and (from_file, to_file) in edge_lookup
        label_from = from_symbol or from_file
        label_to = to_symbol or to_file
        if not label_from or not label_to:
            continue
        key = (label_from, label_to)
        if key in seen:
            continue
        seen.add(key)
        relationships.append({
            "from": label_from,
            "to": label_to,
            "description": _as_text(entry.get("description")).strip(),
            "verified": bool(verified),
            "from_file": from_file,
            "to_file": to_file,
        })
        if len(relationships) >= MAX_RELATIONSHIPS_PER_CHAPTER:
            break
    return relationships


def _issue_summary(finding: dict) -> dict:
    return {
        "title": finding.get("title", ""),
        "severity": finding.get("severity", "info"),
        "kind": finding.get("kind", ""),
        "file": finding.get("file"),
        "line": finding.get("line"),
        "detail": finding.get("detail"),
    }


def ground_story(parsed: dict, record: dict, files: list[dict], issues: list[dict], relationships: list[dict]) -> dict | None:
    """Validate a parsed model response against the real project files."""
    if not isinstance(parsed, dict):
        return None
    raw_chapters = parsed.get("chapters")
    if not isinstance(raw_chapters, list) or not raw_chapters:
        return None

    grounding = _Grounding(files)
    edge_lookup = {(edge.get("from"), edge.get("to")) for edge in relationships}
    chapters = []
    for raw in raw_chapters:
        if not isinstance(raw, dict):
            continue
        title = _as_text(raw.get("title")).strip()
        narrative = _as_text(raw.get("narrative")).strip()
        if not title or not narrative:
            continue

        chapter_files: set[str] = set()
        evidence = _build_evidence(raw.get("evidence"), grounding, chapter_files)
        rels = _build_relationships(raw.get("relationships"), grounding, edge_lookup)
        for rel in rels:
            if rel.get("from_file"):
                chapter_files.add(rel["from_file"])
            if rel.get("to_file"):
                chapter_files.add(rel["to_file"])
        for name in raw.get("source_files") or []:
            resolved = grounding.resolve_file(name)
            if resolved:
                chapter_files.add(resolved)

        chapter_id = raw.get("id") if isinstance(raw.get("id"), str) and raw.get("id").strip() else f"chapter-{len(chapters) + 1}"
        chapters.append({
            "id": chapter_id,
            "title": title,
            "narrative": narrative,
            "how_it_works": _as_text(raw.get("how_it_works")).strip(),
            "why_it_matters": _as_text(raw.get("why_it_matters")).strip(),
            "source_files": sorted(chapter_files),
            "evidence": evidence,
            "relationships": rels,
        })
        if len(chapters) >= SAFETY_CHAPTER_CAP:
            break

    if not chapters:
        return None

    return {
        "title": _as_text(parsed.get("title")).strip() or record.get("name", "Untitled project"),
        "overview": _as_text(parsed.get("overview")).strip(),
        "chapters": chapters,
        "verified_issues": [_issue_summary(finding) for finding in issues[:MAX_VERIFIED_ISSUES]],
    }


# --------------------------------------------------------------------------- #
# Markdown fallback / export
# --------------------------------------------------------------------------- #

def to_markdown(title: str, overview: str, chapters: list[dict]) -> str:
    lines = [f"# {title}" if title else "# Story"]
    if overview:
        lines += ["", overview]
    for chapter in chapters:
        lines += ["", f"## {chapter['title']}", "", chapter["narrative"]]
        if chapter.get("how_it_works"):
            lines += ["", f"**How it works.** {chapter['how_it_works']}"]
        if chapter.get("why_it_matters"):
            lines += ["", f"**Why it matters.** {chapter['why_it_matters']}"]
        if chapter.get("source_files"):
            lines += ["", "**Source files:** " + ", ".join(f"`{path}`" for path in chapter["source_files"])]
        for item in chapter.get("evidence", []):
            label = item.get("file", "")
            if item.get("symbol"):
                label += f" · {item['symbol']}"
            if item.get("line"):
                label += f" (line {item['line']})"
            lines += ["", f"**Evidence — {label}**", "", "```", item.get("snippet", ""), "```"]
        for rel in chapter.get("relationships", []):
            tag = "verified" if rel.get("verified") else "potential"
            lines.append(f"- ({tag}) {rel.get('from')} → {rel.get('to')}: {rel.get('description', '')}")
    return "\n".join(lines)


# --------------------------------------------------------------------------- #
# Orchestration
# --------------------------------------------------------------------------- #

def _call_model(prompt: str, schema: dict) -> dict:
    """One model call returning parsed JSON. Raises StoryError on failure."""
    result = ollama.generate(prompt, response_format=schema)
    if (
        not result.get("ok")
        and result.get("status") == 400
        and "format" in (result.get("error") or "").lower()
    ):
        # Ollama before 0.5 only accepts format="json", not a JSON schema.
        result = ollama.generate(prompt, response_format="json")
    if not result.get("ok"):
        raise StoryError(result.get("error") or "The local AI model is not available.")

    raw_text = (result.get("text") or "").strip()
    if not raw_text:
        raise StoryError("The local AI model returned an empty response. Try generating the story again.")
    return {"model": result.get("model"), "text": raw_text, "parsed": parse_response(raw_text)}


def _generate_incremental(
    record: dict, files: list[dict], relationships: list[dict], issues: list[dict]
) -> dict | None:
    """Large-project path: outline first, then one grounded detail call per chapter."""
    outline_response = _call_model(
        _outline_prompt(record, files, relationships, issues), OUTLINE_RESPONSE_SCHEMA
    )
    outline = outline_response["parsed"]
    if not isinstance(outline, dict):
        return None
    raw_chapters = outline.get("chapters")
    if not isinstance(raw_chapters, list) or not raw_chapters:
        return None

    by_path = {item["path"]: item for item in files}
    grounding = _Grounding(files)
    chapters: list[dict] = []
    for index, entry in enumerate(raw_chapters[:SAFETY_CHAPTER_CAP]):
        if not isinstance(entry, dict) or not _as_text(entry.get("title")).strip():
            continue
        wanted = [
            by_path[path] for name in entry.get("source_files") or []
            for path in [grounding.resolve_file(name)] if path
        ]
        chapter_files = wanted or files[:5]
        chapter_paths = {item["path"] for item in chapter_files}
        chapter_edges = [
            edge for edge in relationships
            if edge.get("from") in chapter_paths or edge.get("to") in chapter_paths
        ]
        try:
            detail = _call_model(
                _chapter_prompt(record, entry, chapter_files, chapter_edges),
                CHAPTER_RESPONSE_SCHEMA,
            )
        except StoryError:
            detail = {"parsed": None}
        parsed_chapter = detail["parsed"] if isinstance(detail["parsed"], dict) else {}
        chapters.append({
            "id": _as_text(entry.get("id")).strip() or f"chapter-{index + 1}",
            "title": _as_text(entry.get("title")).strip(),
            "narrative": _as_text(parsed_chapter.get("narrative")).strip()
                or _as_text(entry.get("summary")).strip(),
            "how_it_works": _as_text(parsed_chapter.get("how_it_works")).strip(),
            "why_it_matters": _as_text(parsed_chapter.get("why_it_matters")).strip(),
            "source_files": entry.get("source_files") or [],
            "evidence": parsed_chapter.get("evidence") or [],
            "relationships": parsed_chapter.get("relationships") or [],
        })

    if not chapters:
        return None
    return {
        "title": _as_text(outline.get("title")).strip() or record.get("name", "Untitled project"),
        "overview": _as_text(outline.get("overview")).strip(),
        "chapters": chapters,
        "model": outline_response["model"],
    }


def generate(record: dict, files: list[dict]) -> dict:
    """Generate a grounded, structured story with the configured local model."""
    relationships = static_analysis.build_map(files).get("edges", [])
    issues = static_analysis.detect_issues(files, record.get("skipped") or {}).get("findings", [])

    prompt, shown = build_prompt(record, files, relationships, issues)
    incremental = len(shown) < len(files)
    model = None
    raw_text = ""
    parsed = None

    if incremental:
        # The whole source does not fit one prompt: plan chapters from the full
        # catalogue, then generate each chapter against its own files.
        incremental_story = _generate_incremental(record, files, relationships, issues)
        if incremental_story is not None:
            model = incremental_story.pop("model", None)
            parsed = incremental_story
    else:
        response = _call_model(prompt, STORY_RESPONSE_SCHEMA)
        model = response["model"]
        raw_text = response["text"]
        parsed = response["parsed"]

    generated_at = datetime.now(timezone.utc).isoformat(timespec="seconds")
    grounded = ground_story(parsed, record, files, issues, relationships) if parsed else None

    coverage = {
        "files_total": len(files),
        "files_excerpted": len(shown),
        "incremental": incremental,
    }
    if grounded:
        grounded.update({
            "structured": True,
            "source": "ollama",
            "model": model,
            "generated_at": generated_at,
            "text": to_markdown(grounded["title"], grounded["overview"], grounded["chapters"]),
            "coverage": coverage,
            "note": (
                "Generated incrementally: chapters were planned from the full file "
                "catalogue and detailed per chapter."
                if incremental else ""
            ),
        })
        return grounded

    return {
        "structured": False,
        "source": "ollama",
        "model": model,
        "generated_at": generated_at,
        "title": record.get("name", "Untitled project"),
        "overview": "",
        "chapters": [],
        "verified_issues": [_issue_summary(finding) for finding in issues[:MAX_VERIFIED_ISSUES]],
        "coverage": coverage,
        "text": raw_text,
        "note": "The model did not return structured chapters, so the raw response is shown below.",
    }
