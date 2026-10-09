"""CodeStory - backend/static_analysis.py

Best-effort, purely static analysis of imported source. Nothing here executes
the imported code; it only reads text and applies heuristics. Results are
approximate and clearly reported as such.
"""

from __future__ import annotations

import posixpath
import re
from collections import Counter

TYPE_BY_EXTENSION = {
    ".html": "markup", ".htm": "markup", ".xml": "markup",
    ".css": "style", ".scss": "style", ".less": "style",
    ".js": "script", ".mjs": "script", ".cjs": "script",
    ".ts": "script", ".jsx": "script", ".tsx": "script", ".vue": "script",
    ".py": "code", ".java": "code", ".php": "code", ".go": "code",
    ".rs": "code", ".cs": "code", ".rb": "code", ".kt": "code", ".swift": "code",
    ".json": "data", ".yaml": "data", ".yml": "data", ".toml": "data",
    ".ini": "data", ".sql": "data",
    ".md": "docs", ".txt": "docs",
}

LEGEND = [
    {"type": "markup", "label": "Markup"},
    {"type": "style", "label": "Styles"},
    {"type": "script", "label": "Scripts"},
    {"type": "code", "label": "Code"},
    {"type": "data", "label": "Data / Config"},
    {"type": "docs", "label": "Docs"},
]

# Reference patterns: capture the specifier inside quotes.
REFERENCE_PATTERNS = [
    re.compile(r"""\bimport\s+(?:[^'"]*?\sfrom\s+)?['"]([^'"]+)['"]"""),
    re.compile(r"""\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)"""),
    re.compile(r"""\bfrom\s+['"]([^'"]+)['"]"""),
    re.compile(r"""@import\s+(?:url\()?['"]([^'"]+)['"]"""),
    re.compile(r"""\b(?:require|include)(?:_once)?\s*\(?\s*['"]([^'"]+)['"]"""),
    re.compile(r"""\bimport\s+\(?\s*['"]([^'"]+)['"]"""),
    # HTML: linked stylesheets / scripts / media.
    re.compile(r"""<link\b[^>]*\bhref\s*=\s*['"]([^'"]+)['"]""", re.IGNORECASE),
    re.compile(r"""<script\b[^>]*\bsrc\s*=\s*['"]([^'"]+)['"]""", re.IGNORECASE),
    re.compile(r"""<img\b[^>]*\bsrc\s*=\s*['"]([^'"]+)['"]""", re.IGNORECASE),
]

MARKER_PATTERN = re.compile(r"\b(TODO|FIXME|HACK|XXX|BUG)\b", re.IGNORECASE)

LONG_LINE_LIMIT = 120
LARGE_FILE_LIMIT = 50_000
MAX_FINDINGS = 200


def _type_for(path: str) -> str:
    ext = posixpath.splitext(path)[1].lower()
    return TYPE_BY_EXTENSION.get(ext, "code")


def _candidates(specifier: str) -> list[str]:
    """Produce possible project-relative paths for a raw import specifier."""
    spec = specifier.strip()
    if not spec:
        return []
    spec = spec.split("?")[0].split("#")[0]
    results = [spec]
    for ext in (".js", ".ts", ".jsx", ".tsx", ".mjs", ".cjs", ".json", ".vue"):
        results.append(spec + ext)
    results.append(spec + "/index.js")
    results.append(spec + "/index.ts")
    return results


def _resolve(specifier: str, source_path: str, path_lookup: dict, stem_lookup: dict) -> str | None:
    directory = posixpath.dirname(source_path)
    is_relative = specifier.startswith(".")

    for candidate in _candidates(specifier):
        if is_relative:
            resolved = posixpath.normpath(posixpath.join(directory, candidate))
            if resolved in path_lookup:
                return resolved
        else:
            # Bare specifier - try to match a project file by basename/stem.
            base = posixpath.basename(candidate)
            stem = posixpath.splitext(base)[0]
            if base in path_lookup:
                return base
            if stem in stem_lookup:
                return stem_lookup[stem][0]
    return None


def build_map(file_records: list[dict]) -> dict:
    """Build a file relationship graph from import/reference statements."""
    path_lookup = {r["path"]: r["path"] for r in file_records}
    stem_lookup: dict[str, list[str]] = {}
    for record in file_records:
        stem = posixpath.splitext(posixpath.basename(record["path"]))[0].lower()
        stem_lookup.setdefault(stem, []).append(record["path"])

    nodes = [
        {
            "id": record["path"],
            "path": record["path"],
            "label": posixpath.basename(record["path"]),
            "type": _type_for(record["path"]),
            "language": record.get("language", ""),
        }
        for record in file_records
    ]

    edges: list[dict] = []
    seen: set[tuple[str, str]] = set()

    for record in file_records:
        content = record.get("content", "")
        references: set[str] = set()
        for pattern in REFERENCE_PATTERNS:
            for match in pattern.findall(content):
                references.add(match)
        for specifier in references:
            target = _resolve(specifier, record["path"], path_lookup, stem_lookup)
            if target and target != record["path"]:
                key = (record["path"], target)
                if key not in seen:
                    seen.add(key)
                    edges.append({"from": record["path"], "to": target, "kind": "references"})

    type_counts = Counter(node["type"] for node in nodes)
    return {
        "nodes": nodes,
        "edges": edges,
        "legend": LEGEND,
        "stats": {
            "files": len(nodes),
            "connections": len(edges),
            "by_type": dict(type_counts),
        },
        "generated": True,
        "notes": (
            "Relationships are inferred from import/include statements by pattern "
            "matching and may be incomplete."
        ),
    }


def detect_issues(file_records: list[dict], skipped: dict | None = None) -> dict:
    """Return best-effort static findings. No code is executed."""
    findings: list[dict] = []

    def add(**finding):
        if len(findings) < MAX_FINDINGS:
            finding.setdefault("source", "static")
            findings.append(finding)

    total_lines = 0
    for record in file_records:
        content = record.get("content", "")
        lines = content.splitlines()
        total_lines += len(lines)
        path = record["path"]

        for number, line in enumerate(lines, 1):
            match = MARKER_PATTERN.search(line)
            if match:
                add(
                    kind="marker",
                    severity="info",
                    title=f"{match.group(1).upper()} marker",
                    file=path,
                    line=number,
                    detail=line.strip()[:160],
                )

        long_lines = [i for i, line in enumerate(lines, 1) if len(line) > LONG_LINE_LIMIT]
        if long_lines:
            add(
                kind="style",
                severity="info",
                title=f"{len(long_lines)} line(s) exceed {LONG_LINE_LIMIT} characters",
                file=path,
                line=long_lines[0],
                detail=f"First long line at line {long_lines[0]}.",
            )

        if record.get("size", 0) > LARGE_FILE_LIMIT:
            add(
                kind="size",
                severity="warning",
                title="Large file",
                file=path,
                detail=f"{record['size']:,} bytes - consider splitting for readability.",
            )

    lowercase = {record["path"].lower() for record in file_records}
    if not any(p.endswith(("readme.md", "readme.txt", "readme")) for p in lowercase):
        add(kind="docs", severity="info", title="No README found",
            detail="A README helps others understand the project.")
    if not any("test" in p or "spec" in p for p in lowercase):
        add(kind="tests", severity="info", title="No test files detected",
            detail="No file names containing 'test' or 'spec' were found.")

    if skipped:
        for category, paths in skipped.items():
            if not paths:
                continue
            label = category.replace("_", " ")
            severity = "warning" if category in ("secrets", "binary") else "info"
            detail = ", ".join(paths[:5])
            if len(paths) > 5:
                detail += f" (+{len(paths) - 5} more)"
            add(
                kind="excluded",
                severity=severity,
                title=f"{len(paths)} file(s) excluded as {label}",
                detail=detail,
            )

    counts = Counter(finding["severity"] for finding in findings)
    return {
        "findings": findings,
        "summary": {
            "total": len(findings),
            "warning": counts.get("warning", 0),
            "info": counts.get("info", 0),
        },
        "stats": {"files_analyzed": len(file_records), "lines_scanned": total_lines},
        "generated": True,
        "disclaimer": (
            "Static analysis only: findings come from pattern matching over the "
            "source text. It does not execute the code and does not detect every "
            "issue."
        ),
    }
