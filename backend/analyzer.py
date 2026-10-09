"""CodeStory - backend/analyzer.py

Import validation and analysis for CodeStory.

This module never executes the imported code. It only reads bytes, enforces
size / count limits, filters out secrets, dependencies, generated and binary
files, and reports what was imported.
"""

from __future__ import annotations

import io
import os
import posixpath
import zipfile
from collections import Counter
from pathlib import Path
from typing import Iterable

# --------------------------------------------------------------------------- #
# Limits
# --------------------------------------------------------------------------- #

def _env_int(name: str, default: int) -> int:
    """Read an integer limit from the environment, falling back to default."""
    try:
        value = int(os.environ.get(name, ""))
        return value if value > 0 else default
    except (TypeError, ValueError):
        return default


MAX_FILE_SIZE = _env_int("CODESTORY_MAX_FILE_SIZE", 1_000_000)          # 1 MB per file
MAX_TOTAL_SIZE = _env_int("CODESTORY_MAX_TOTAL_SIZE", 200_000_000)      # 200 MB of source
MAX_FILE_COUNT = _env_int("CODESTORY_MAX_FILE_COUNT", 10_000)           # files per project
MAX_PATH_LENGTH = 400              # maximum length of a stored path

MAX_UPLOAD_SIZE = _env_int("CODESTORY_MAX_UPLOAD_SIZE", 200_000_000)    # raw upload bytes
MAX_ZIP_ENTRIES = _env_int("CODESTORY_MAX_ZIP_ENTRIES", 20_000)         # .zip entries
MAX_UNCOMPRESSED_SIZE = _env_int(
    "CODESTORY_MAX_UNCOMPRESSED_SIZE", 1_000_000_000)                   # zip-bomb guard

# Analysis preferences that the backend can honour. Secrets are always
# excluded and cannot be re-enabled.
DEFAULT_OPTIONS = {
    "exclude_generated": True,
    "exclude_dependencies": True,
    "flag_unsupported": True,
    "max_file_size": MAX_FILE_SIZE,
    "max_total_size": MAX_TOTAL_SIZE,
    "max_file_count": MAX_FILE_COUNT,
}


def resolve_options(overrides: dict | None = None) -> dict:
    options = dict(DEFAULT_OPTIONS)
    if overrides:
        for key, value in overrides.items():
            if key in options and value is not None:
                options[key] = value
    return options

# --------------------------------------------------------------------------- #
# Supported types
# --------------------------------------------------------------------------- #

SUPPORTED_EXTENSIONS = {
    # Web
    ".html", ".css", ".js", ".ts", ".jsx", ".tsx",
    # Backend
    ".py", ".java", ".php", ".go", ".rs", ".cs",
    # Data & configuration
    ".sql", ".json", ".xml", ".yaml", ".yml", ".toml", ".ini",
    # Documentation
    ".md", ".txt",
}

LANGUAGE_BY_EXTENSION = {
    ".html": "HTML",
    ".css": "CSS",
    ".js": "JavaScript",
    ".ts": "TypeScript",
    ".jsx": "JavaScript (JSX)",
    ".tsx": "TypeScript (TSX)",
    ".py": "Python",
    ".java": "Java",
    ".php": "PHP",
    ".go": "Go",
    ".rs": "Rust",
    ".cs": "C#",
    ".sql": "SQL",
    ".json": "JSON",
    ".xml": "XML",
    ".yaml": "YAML",
    ".yml": "YAML",
    ".toml": "TOML",
    ".ini": "INI",
    ".md": "Markdown",
    ".txt": "Text",
}

CATEGORY_BY_LANGUAGE = {
    "HTML": "Web", "CSS": "Web", "JavaScript": "Web", "TypeScript": "Web",
    "JavaScript (JSX)": "Web", "TypeScript (TSX)": "Web",
    "Python": "Backend", "Java": "Backend", "PHP": "Backend", "Go": "Backend",
    "Rust": "Backend", "C#": "Backend",
    "SQL": "Data", "JSON": "Data", "XML": "Data", "YAML": "Data",
    "TOML": "Data", "INI": "Data",
    "Markdown": "Documentation", "Text": "Documentation",
}

# --------------------------------------------------------------------------- #
# Exclusions
# --------------------------------------------------------------------------- #

# Directory name (lowercased) -> exclusion category
EXCLUDED_DIRECTORIES = {
    # Dependencies / third-party code
    "node_modules": "dependencies",
    "bower_components": "dependencies",
    "jspm_packages": "dependencies",
    "vendor": "dependencies",
    "packages": "dependencies",
    "site-packages": "dependencies",
    ".venv": "dependencies",
    "venv": "dependencies",
    "virtualenv": "dependencies",
    "env": "dependencies",
    # Version control / editor metadata
    ".git": "generated",
    ".svn": "generated",
    ".hg": "generated",
    ".idea": "generated",
    ".vscode": "generated",
    ".vs": "generated",
    # Build output / caches
    "dist": "generated",
    "build": "generated",
    "out": "generated",
    "target": "generated",
    "bin": "generated",
    "obj": "generated",
    "coverage": "generated",
    "debug": "generated",
    "release": "generated",
    "__pycache__": "generated",
    ".next": "generated",
    ".nuxt": "generated",
    ".cache": "generated",
    ".parcel-cache": "generated",
    ".pytest_cache": "generated",
    ".mypy_cache": "generated",
    ".ruff_cache": "generated",
    "logs": "generated",
    "tmp": "generated",
    "temp": "generated",
    ".terraform": "generated",
    ".gradle": "generated",
    ".mvn": "generated",
    "cmakefiles": "generated",
    "pods": "generated",
    "deriveddata": "generated",
    # Secrets
    ".ssh": "secrets",
    ".aws": "secrets",
    ".gnupg": "secrets",
}

# Exact filenames (lowercased) -> exclusion category
EXCLUDED_FILENAMES = {
    ".env": "secrets",
    ".env.local": "secrets",
    ".env.development": "secrets",
    ".env.production": "secrets",
    ".env.test": "secrets",
    ".npmrc": "secrets",
    ".netrc": "secrets",
    "id_rsa": "secrets",
    "id_dsa": "secrets",
    "id_ecdsa": "secrets",
    "id_ed25519": "secrets",
    "known_hosts": "secrets",
    "package-lock.json": "generated",
    "npm-shrinkwrap.json": "generated",
    "yarn.lock": "generated",
    "pnpm-lock.yaml": "generated",
    "composer.lock": "generated",
    "gemfile.lock": "generated",
    "cargo.lock": "generated",
    "poetry.lock": "generated",
    "go.sum": "generated",
    ".ds_store": "generated",
    "thumbs.db": "generated",
    "desktop.ini": "generated",
}

# File suffix (lowercased) -> exclusion category
EXCLUDED_SUFFIXES = {
    ".pem": "secrets",
    ".key": "secrets",
    ".ppk": "secrets",
    ".p12": "secrets",
    ".pfx": "secrets",
    ".keystore": "secrets",
    ".jks": "secrets",
    ".asc": "secrets",
    ".gpg": "secrets",
    ".min.js": "generated",
    ".min.css": "generated",
    ".map": "generated",
    ".lock": "generated",
    ".pyc": "generated",
    ".pyo": "generated",
    ".class": "generated",
    ".o": "generated",
    ".so": "generated",
    ".dll": "generated",
    ".exe": "generated",
    ".bin": "generated",
    ".bak": "generated",
}

SKIPPED_CATEGORIES = (
    "secrets", "dependencies", "generated", "unsupported",
    "binary", "too_large", "unsafe", "duplicates", "unreadable",
)


class ImportValidationError(Exception):
    """Raised when an import cannot be completed and a clear error is required."""

    def __init__(self, message: str, status_code: int = 400) -> None:
        super().__init__(message)
        self.message = message
        self.status_code = status_code


# --------------------------------------------------------------------------- #
# Helpers
# --------------------------------------------------------------------------- #

def _normalize_path(raw_path: str) -> str | None:
    """Return a safe posix path, or None when the path is unsafe/empty."""
    path = (raw_path or "").replace("\\", "/").strip()
    while path.startswith("./"):
        path = path[2:]
    if not path:
        return None
    normalized = posixpath.normpath(path)
    if normalized in (".", ""):
        return None
    if normalized.startswith("/") or normalized == ".." or normalized.startswith("../"):
        return None
    if "/../" in normalized:
        return None
    return normalized


def _exclusion_category(path: str, options: dict) -> str | None:
    """Return the exclusion category for a path, or None if it is a candidate.

    Secrets are always excluded. Generated files and dependency folders can be
    re-included through analysis options.
    """
    allow_generated = not options.get("exclude_generated", True)
    allow_dependencies = not options.get("exclude_dependencies", True)

    parts = [part.lower() for part in path.split("/")]
    for part in parts[:-1]:
        category = EXCLUDED_DIRECTORIES.get(part)
        if not category:
            continue
        if category == "generated" and allow_generated:
            continue
        if category == "dependencies" and allow_dependencies:
            continue
        return category

    filename = parts[-1]
    if any(part.startswith(".env") for part in parts):
        return "secrets"
    if filename in EXCLUDED_FILENAMES:
        category = EXCLUDED_FILENAMES[filename]
        if category == "generated" and allow_generated:
            return None
        if category == "dependencies" and allow_dependencies:
            return None
        return category
    for suffix, category in EXCLUDED_SUFFIXES.items():
        if filename.endswith(suffix):
            if category == "generated" and allow_generated:
                return None
            if category == "dependencies" and allow_dependencies:
                return None
            return category
    return None


def _decode_text(data: bytes) -> str | None:
    """Decode bytes as text, or return None when the content looks binary."""
    if b"\x00" in data[:8192]:
        return None

    text: str | None = None
    for encoding in ("utf-8", "utf-8-sig"):
        try:
            text = data.decode(encoding)
            break
        except UnicodeDecodeError:
            continue
    if text is None:
        try:
            text = data.decode("latin-1")
        except UnicodeDecodeError:
            return None

    sample = text[:4096]
    if sample:
        control = sum(1 for ch in sample if ord(ch) < 9 or 13 < ord(ch) < 32)
        if control / len(sample) > 0.05:
            return None
    return text


def _infer_project_name(paths: Iterable[str], fallback: str) -> str:
    normalized = [p for p in paths if p]
    if normalized and all("/" in p for p in normalized):
        roots = {p.split("/")[0] for p in normalized}
        if len(roots) == 1:
            return roots.pop()
    return fallback


# --------------------------------------------------------------------------- #
# Core analysis
# --------------------------------------------------------------------------- #

def analyze_files(
    files: Iterable[tuple[str, bytes]],
    project_name: str,
    options: dict | None = None,
    with_content: bool = False,
    preskipped: Iterable[tuple[str, str]] | None = None,
) -> dict:
    """Validate and describe a set of (path, bytes) source files.

    Raises ImportValidationError when nothing usable is found or a limit is
    exceeded. Imported code is never executed. When ``with_content`` is True the
    accepted files include their decoded text under an ``accepted`` key (used for
    local storage and analysis, never returned to the browser directly).
    """
    resolved = resolve_options(options)
    max_file_size = resolved["max_file_size"]
    max_total_size = resolved["max_total_size"]
    max_file_count = resolved["max_file_count"]

    imported: list[dict] = []
    skipped: dict[str, list[str]] = {category: [] for category in SKIPPED_CATEGORIES}
    seen_paths: set[str] = set()
    total_size = 0

    for raw_path, data in files:
        path = _normalize_path(raw_path)
        if path is None or len(path) > MAX_PATH_LENGTH:
            skipped["unsafe"].append(raw_path or "<unnamed>")
            continue

        if path in seen_paths:
            skipped["duplicates"].append(path)
            continue
        seen_paths.add(path)

        category = _exclusion_category(path, resolved)
        if category:
            skipped[category].append(path)
            continue

        suffix = Path(path).suffix.lower()
        if suffix not in SUPPORTED_EXTENSIONS:
            skipped["unsupported"].append(path)
            continue

        size = len(data)
        if size > max_file_size:
            skipped["too_large"].append(path)
            continue

        text = _decode_text(data)
        if text is None:
            skipped["binary"].append(path)
            continue

        if len(imported) >= max_file_count:
            raise ImportValidationError(
                f"Too many files: the limit is {max_file_count} supported files per project.",
                status_code=413,
            )
        total_size += size
        if total_size > max_total_size:
            raise ImportValidationError(
                f"Total size limit exceeded: the limit is "
                f"{max_total_size // 1_000_000} MB of supported source.",
                status_code=413,
            )

        item = {
            "path": path,
            "language": LANGUAGE_BY_EXTENSION[suffix],
            "category": CATEGORY_BY_LANGUAGE.get(LANGUAGE_BY_EXTENSION[suffix], "Other"),
            "size": size,
            "lines": text.count("\n") + (0 if text.endswith("\n") or not text else 1),
        }
        if with_content:
            item["content"] = text
        imported.append(item)

    # preskipped is filled lazily by streaming producers (e.g. zip readers),
    # so it can only be merged once ``files`` has been consumed.
    for raw_path, category in preskipped or ():
        path = _normalize_path(raw_path)
        name = path or raw_path or "<unnamed>"
        if name in seen_paths:
            continue
        seen_paths.add(name)
        if category in skipped:
            skipped[category].append(name)

    if not imported:
        raise ImportValidationError(
            "No supported source files were found. Supported types include "
            ".html, .css, .js, .ts, .jsx, .tsx, .py, .java, .php, .go, .rs, "
            ".cs, .sql, .json, .xml, .yaml, .yml, .toml, .ini, .md and .txt."
        )

    language_counts = Counter(item["language"] for item in imported)
    detected_types = [
        {
            "language": language,
            "category": CATEGORY_BY_LANGUAGE.get(language, "Other"),
            "count": count,
        }
        for language, count in language_counts.most_common()
    ]

    result = {
        "project_name": project_name or "Untitled project",
        "file_count": len(imported),
        "total_size": total_size,
        "total_lines": sum(item["lines"] for item in imported),
        "detected_types": detected_types,
        "files": [
            {"path": item["path"], "language": item["language"], "size": item["size"]}
            for item in imported
        ],
        "skipped": {category: paths for category, paths in skipped.items() if paths},
        "skipped_count": sum(len(paths) for paths in skipped.values()),
        "limits": {
            "max_file_size": max_file_size,
            "max_total_size": max_total_size,
            "max_file_count": max_file_count,
        },
    }
    if with_content:
        result["accepted"] = imported
        result["options"] = resolved
    return result


class _SeekableWrapper:
    """Give a spooled upload file the file-object API zipfile needs.

    ``tempfile.SpooledTemporaryFile`` does not expose ``seekable`` /
    ``readable`` before it rolls over to disk, which ``zipfile`` checks.
    """

    def __init__(self, raw) -> None:
        self._raw = raw

    def __getattr__(self, name):
        return getattr(self._raw, name)

    def seekable(self) -> bool:
        return True

    def readable(self) -> bool:
        return True


def _check_upload_size(size: int, what: str = "upload") -> None:
    if size > MAX_UPLOAD_SIZE:
        raise ImportValidationError(
            f"The {what} is too large: the limit is {MAX_UPLOAD_SIZE // 1_000_000} MB.",
            status_code=413,
        )


def _iter_zip_files(
    archive: zipfile.ZipFile,
    max_file_size: int,
    preskipped: list[tuple[str, str]],
) -> Iterable[tuple[str, bytes]]:
    """Yield (name, bytes) entries lazily so large archives never sit fully
    in memory. Entries that cannot be read or exceed the per-file limit are
    not read at all; they are recorded under ``preskipped`` instead."""
    uncompressed = 0
    with archive:
        for info in archive.infolist():
            if info.is_dir():
                continue
            uncompressed += info.file_size
            if uncompressed > MAX_UNCOMPRESSED_SIZE:
                raise ImportValidationError(
                    "The ZIP expands to too much data and was rejected.",
                    status_code=413,
                )
            if info.file_size > max_file_size:
                # Larger than any accepted source file - never read it.
                preskipped.append((info.filename, "too_large"))
                continue
            try:
                content = archive.read(info)
            except (RuntimeError, zipfile.BadZipFile, OSError):
                # Encrypted or unreadable entry - skip rather than fail.
                preskipped.append((info.filename, "unreadable"))
                continue
            yield (info.filename, content)


def analyze_zip(
    data,
    filename: str,
    options: dict | None = None,
    with_content: bool = False,
    max_file_size: int | None = None,
) -> dict:
    """Validate and analyze a .zip upload.

    ``data`` may be raw bytes or a seekable binary file object (e.g. a spooled
    upload). Entries are streamed one at a time so a large archive never loads
    the whole project into memory at once.
    """
    resolved = resolve_options(options)
    per_file_limit = max_file_size or resolved["max_file_size"]

    if hasattr(data, "read"):
        stream = data
        if not callable(getattr(stream, "seekable", None)):
            stream = _SeekableWrapper(stream)
        stream.seek(0, os.SEEK_END)
        size = stream.tell()
        stream.seek(0)
    else:
        size = len(data)
        stream = io.BytesIO(data)

    if size == 0:
        raise ImportValidationError("The uploaded ZIP file is empty.")
    _check_upload_size(size, "ZIP")

    try:
        archive = zipfile.ZipFile(stream)
    except zipfile.BadZipFile:
        raise ImportValidationError("The uploaded file is not a valid ZIP archive.")

    infos = archive.infolist()
    if len(infos) > MAX_ZIP_ENTRIES:
        archive.close()
        raise ImportValidationError(
            f"The ZIP contains too many entries: the limit is {MAX_ZIP_ENTRIES}.",
            status_code=413,
        )

    file_names = [info.filename for info in infos if not info.is_dir()]
    project_name = _infer_project_name(
        (_normalize_path(path) for path in file_names),
        Path(filename or "project.zip").stem,
    )

    preskipped: list[tuple[str, str]] = []
    return analyze_files(
        _iter_zip_files(archive, per_file_limit, preskipped),
        project_name,
        options=resolved,
        with_content=with_content,
        preskipped=preskipped,
    )
