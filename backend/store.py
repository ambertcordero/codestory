"""CodeStory - backend/store.py

Local, on-disk project store. Projects are saved under backend/data/ so they
survive restarts. This is the single source of truth for imported projects.

Layout:

    backend/data/
      index.json                 metadata for every project (no source)
      settings.json              analysis preferences
      projects/<id>/files/...    the accepted source files
      stories/<id>.json          cached generated stories
"""

from __future__ import annotations

import json
import posixpath
import shutil
import uuid
from datetime import datetime, timezone
from pathlib import Path

BASE_DIR = Path(__file__).resolve().parent
DATA_DIR = BASE_DIR / "data"
PROJECTS_DIR = DATA_DIR / "projects"
STORIES_DIR = DATA_DIR / "stories"
INDEX_FILE = DATA_DIR / "index.json"
SETTINGS_FILE = DATA_DIR / "settings.json"

DEFAULT_SETTINGS = {
    "ollama_host": "http://127.0.0.1:11434",
    "ollama_model": "qwen2.5-coder:3b",
    "exclude_generated": True,
    "exclude_dependencies": True,
    "flag_unsupported": True,
    "max_file_size": 1_000_000,
    "max_total_size": 200_000_000,
    "max_file_count": 10_000,
}


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def ensure_dirs() -> None:
    PROJECTS_DIR.mkdir(parents=True, exist_ok=True)
    STORIES_DIR.mkdir(parents=True, exist_ok=True)


def _read_json(path: Path, fallback):
    try:
        with path.open("r", encoding="utf-8") as handle:
            return json.load(handle)
    except (OSError, json.JSONDecodeError):
        return fallback


def _write_json(path: Path, payload) -> None:
    ensure_dirs()
    tmp = path.with_suffix(path.suffix + ".tmp")
    with tmp.open("w", encoding="utf-8") as handle:
        json.dump(payload, handle, ensure_ascii=False, indent=2)
    tmp.replace(path)


# --------------------------------------------------------------------------- #
# Settings
# --------------------------------------------------------------------------- #

def load_settings() -> dict:
    settings = dict(DEFAULT_SETTINGS)
    stored = _read_json(SETTINGS_FILE, {})
    if isinstance(stored, dict):
        settings.update({k: v for k, v in stored.items() if k in DEFAULT_SETTINGS})
    return settings


def save_settings(updates: dict) -> dict:
    settings = load_settings()
    for key, value in (updates or {}).items():
        if key in DEFAULT_SETTINGS and value is not None:
            settings[key] = value
    _write_json(SETTINGS_FILE, settings)
    return settings


# --------------------------------------------------------------------------- #
# Index
# --------------------------------------------------------------------------- #

def _load_index() -> dict:
    index = _read_json(INDEX_FILE, {"projects": []})
    if not isinstance(index, dict) or not isinstance(index.get("projects"), list):
        return {"projects": []}
    return index


def _save_index(index: dict) -> None:
    _write_json(INDEX_FILE, index)


def list_projects() -> list[dict]:
    return _load_index()["projects"]


def get_project(project_id: str) -> dict | None:
    for project in _load_index()["projects"]:
        if project.get("id") == project_id:
            return project
    return None


def _public_summary(summary: dict, project_name: str) -> dict:
    return {
        "project_name": summary.get("project_name", project_name),
        "file_count": summary.get("file_count", 0),
        "total_size": summary.get("total_size", 0),
        "total_lines": summary.get("total_lines", 0),
        "detected_types": summary.get("detected_types", []),
        "files": summary.get("files", []),
        "skipped": summary.get("skipped", {}),
        "skipped_count": summary.get("skipped_count", 0),
        "limits": summary.get("limits", {}),
    }


def create_project(summary: dict, accepted: list[dict], source: str) -> dict:
    """Persist an imported project and return its metadata record."""
    ensure_dirs()
    project_id = uuid.uuid4().hex[:12]
    project_dir = PROJECTS_DIR / project_id
    files_dir = project_dir / "files"

    for item in accepted:
        destination = files_dir / item["path"]
        destination.parent.mkdir(parents=True, exist_ok=True)
        destination.write_text(item.get("content", ""), encoding="utf-8")

    record = {
        "id": project_id,
        "name": summary.get("project_name") or "Untitled project",
        "source": source,
        "demo": source == "demo",
        "status": "analyzed",
        "created_at": _now(),
        "analyzed_at": _now(),
        "file_count": summary.get("file_count", 0),
        "total_size": summary.get("total_size", 0),
        "total_lines": summary.get("total_lines", 0),
        "detected_types": summary.get("detected_types", []),
        "files": [
            {
                "path": item["path"],
                "language": item["language"],
                "category": item.get("category", "Other"),
                "size": item["size"],
                "lines": item.get("lines", 0),
            }
            for item in accepted
        ],
        "skipped": summary.get("skipped", {}),
        "skipped_count": summary.get("skipped_count", 0),
    }

    index = _load_index()
    index["projects"].insert(0, record)
    _save_index(index)
    return record


def update_project(project_id: str, **fields) -> dict | None:
    index = _load_index()
    updated = None
    for project in index["projects"]:
        if project.get("id") == project_id:
            project.update(fields)
            updated = project
            break
    if updated is not None:
        _save_index(index)
    return updated


def delete_project(project_id: str) -> bool:
    index = _load_index()
    remaining = [p for p in index["projects"] if p.get("id") != project_id]
    if len(remaining) == len(index["projects"]):
        return False
    index["projects"] = remaining
    _save_index(index)
    shutil.rmtree(PROJECTS_DIR / project_id, ignore_errors=True)
    (STORIES_DIR / f"{project_id}.json").unlink(missing_ok=True)
    return True


def read_project_files(project_id: str) -> list[dict]:
    """Return accepted files with their text content."""
    record = get_project(project_id)
    if record is None:
        return []
    root = PROJECTS_DIR / project_id / "files"
    files = []
    for item in record.get("files", []):
        path = item["path"]
        full = root / Path(posixpath.normpath(path))
        try:
            content = full.read_text(encoding="utf-8")
        except OSError:
            content = ""
        files.append({**item, "content": content})
    return files


def read_project_file(project_id: str, rel_path: str) -> str | None:
    record = get_project(project_id)
    if record is None:
        return None
    normalized = posixpath.normpath(rel_path.replace("\\", "/"))
    if normalized.startswith("..") or normalized.startswith("/"):
        return None
    full = PROJECTS_DIR / project_id / "files" / Path(normalized)
    try:
        return full.read_text(encoding="utf-8")
    except OSError:
        return None


# --------------------------------------------------------------------------- #
# Stories cache
# --------------------------------------------------------------------------- #

def load_story(project_id: str) -> dict | None:
    return _read_json(STORIES_DIR / f"{project_id}.json", None)


def save_story(project_id: str, story: dict) -> dict:
    _write_json(STORIES_DIR / f"{project_id}.json", story)
    return story


def clear_all() -> None:
    shutil.rmtree(DATA_DIR, ignore_errors=True)
    ensure_dirs()
