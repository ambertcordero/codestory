"""CodeStory - backend/main.py

Local FastAPI backend for CodeStory project imports, analysis, project storage
and optional local AI (Ollama) story generation.

Run locally (no internet required):

    cd backend
    python -m pip install -r requirements.txt
    python -m uvicorn main:app --host 127.0.0.1 --port 8000

Imported source code is never executed.
"""

from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path
from typing import List, Optional

from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

import ollama
import static_analysis
import store
import story as story_module
import visuals
from analyzer import (
    MAX_FILE_SIZE,
    MAX_UPLOAD_SIZE,
    MAX_ZIP_ENTRIES,
    SUPPORTED_EXTENSIONS,
    ImportValidationError,
    analyze_files,
    analyze_zip,
)

app = FastAPI(
    title="CodeStory API",
    version="1.1.0",
    description="Local project import, analysis, storage and AI for CodeStory.",
)

# The front end is opened from file:// or from XAMPP (http://localhost), so the
# backend allows local cross-origin requests. This service is local-only.
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


class Snippet(BaseModel):
    filename: str
    content: str
    project_name: str = ""
    source: str = "snippet"


class SettingsUpdate(BaseModel):
    ollama_host: Optional[str] = None
    ollama_model: Optional[str] = None
    exclude_generated: Optional[bool] = None
    exclude_dependencies: Optional[bool] = None
    flag_unsupported: Optional[bool] = None
    max_file_size: Optional[int] = None
    max_total_size: Optional[int] = None
    max_file_count: Optional[int] = None


def _describe_supported() -> str:
    return ", ".join(sorted(SUPPORTED_EXTENSIONS))


def _analysis_options() -> dict:
    settings = store.load_settings()
    return {
        "exclude_generated": settings.get("exclude_generated", True),
        "exclude_dependencies": settings.get("exclude_dependencies", True),
        "max_file_size": settings.get("max_file_size"),
        "max_total_size": settings.get("max_total_size"),
        "max_file_count": settings.get("max_file_count"),
    }


def _persist(result: dict, source: str) -> dict:
    """Store an analyze_* result and fold the project id back into the payload."""
    accepted = result.pop("accepted", [])
    result.pop("options", None)
    record = store.create_project(result, accepted, source)
    result["project_id"] = record["id"]
    result["id"] = record["id"]
    result["source"] = source
    result["demo"] = record["demo"]
    result["created_at"] = record["created_at"]
    return result


# --------------------------------------------------------------------------- #
# Built-in demo project
# --------------------------------------------------------------------------- #

# The built-in demo lives in the repository next to the backend folder, so the
# same real source files power the demo and the offline sample application.
DEMO_DIR = Path(__file__).resolve().parent.parent / "simple-pos-demo"
DEMO_NAME = "Simple POS System"
DEMO_DESCRIPTION = (
    "A tiny point-of-sale demo built with plain HTML, CSS and JavaScript: a "
    "product list, a shopping cart with quantity controls, automatic subtotal "
    "and total calculation, and a simulated cash checkout that prints a "
    "receipt. Everything runs offline in the browser."
)
DEMO_FILE_ORDER = [
    "index.html",
    "css/style.css",
    "js/products.js",
    "js/cart.js",
    "js/app.js",
    "README.md",
]


@app.get("/api/demo")
def get_demo() -> dict:
    """Return the bundled demo project's real source files, for review first."""
    if not DEMO_DIR.is_dir():
        raise HTTPException(status_code=404, detail="The built-in demo project is not available.")

    collected: list[tuple[str, bytes]] = []
    for rel_path in DEMO_FILE_ORDER:
        target = DEMO_DIR / rel_path
        if target.is_file():
            collected.append((rel_path, target.read_bytes()))

    if not collected:
        raise HTTPException(status_code=404, detail="The built-in demo project is not available.")

    try:
        result = analyze_files(collected, DEMO_NAME, options=_analysis_options(), with_content=True)
    except ImportValidationError as exc:
        raise HTTPException(status_code=exc.status_code, detail=exc.message)

    return {
        "name": DEMO_NAME,
        "description": DEMO_DESCRIPTION,
        "label": "Built-in Demo Project",
        "source": "demo",
        "file_count": result["file_count"],
        "total_lines": result["total_lines"],
        "total_size": result["total_size"],
        "detected_types": result["detected_types"],
        "files": [
            {
                "path": item["path"],
                "language": item["language"],
                "category": item.get("category", "Other"),
                "size": item["size"],
                "lines": item["lines"],
                "content": item.get("content", ""),
            }
            for item in result["accepted"]
        ],
    }


# --------------------------------------------------------------------------- #
# Health and imports
# --------------------------------------------------------------------------- #

@app.get("/api/health")
def health() -> dict:
    return {"status": "ok", "service": "codestory", "version": app.version}


@app.post("/api/import/zip")
async def import_zip(file: UploadFile = File(...), source: str = Form("zip")) -> dict:
    if file.size is not None and file.size > MAX_UPLOAD_SIZE:
        raise HTTPException(
            status_code=413,
            detail=f"The ZIP is too large: the limit is {MAX_UPLOAD_SIZE // 1_000_000} MB.",
        )
    try:
        # The spooled upload file is seekable, so entries are streamed from it
        # instead of copying the whole archive into memory first.
        result = analyze_zip(
            file.file,
            file.filename or "project.zip",
            options=_analysis_options(),
            with_content=True,
        )
    except ImportValidationError as exc:
        raise HTTPException(status_code=exc.status_code, detail=exc.message)
    return _persist(result, source or "zip")


@app.post("/api/import/files")
async def import_files(
    files: List[UploadFile] = File(...),
    paths: str = Form("[]"),
    project_name: str = Form(""),
    source: str = Form("files"),
) -> dict:
    try:
        path_list = json.loads(paths) if paths else []
    except json.JSONDecodeError:
        raise HTTPException(status_code=400, detail="Invalid file path payload.")
    if not isinstance(path_list, list):
        raise HTTPException(status_code=400, detail="Invalid file path payload.")

    if len(files) > MAX_ZIP_ENTRIES:
        raise HTTPException(
            status_code=413,
            detail=f"Too many files in the upload: the limit is {MAX_ZIP_ENTRIES}.",
        )

    collected: list[tuple[str, bytes]] = []
    total = 0
    for index, upload in enumerate(files):
        data = await upload.read()
        total += len(data)
        if total > MAX_UPLOAD_SIZE:
            raise HTTPException(
                status_code=413,
                detail=f"The upload is too large: the limit is {MAX_UPLOAD_SIZE // 1_000_000} MB.",
            )
        safe_path = path_list[index] if index < len(path_list) else upload.filename
        collected.append((safe_path or upload.filename or f"file-{index}", data))

    try:
        result = analyze_files(
            collected,
            project_name,
            options=_analysis_options(),
            with_content=True,
        )
    except ImportValidationError as exc:
        raise HTTPException(status_code=exc.status_code, detail=exc.message)
    return _persist(result, source or "files")


@app.post("/api/import/snippet")
async def import_snippet(snippet: Snippet) -> dict:
    filename = (snippet.filename or "").strip()
    if not filename:
        raise HTTPException(status_code=400, detail="Enter a file name for the snippet.")

    suffix = Path(filename).suffix.lower()
    if suffix not in SUPPORTED_EXTENSIONS:
        raise HTTPException(
            status_code=400,
            detail=f"Unsupported file type '{suffix or filename}'. Supported types: {_describe_supported()}.",
        )

    data = snippet.content.encode("utf-8")
    if len(data) == 0:
        raise HTTPException(status_code=400, detail="The pasted snippet is empty.")
    if len(data) > MAX_FILE_SIZE:
        raise HTTPException(
            status_code=413,
            detail=f"The snippet is too large (limit {MAX_FILE_SIZE // 1_000_000} MB).",
        )

    try:
        result = analyze_files(
            [(filename, data)],
            snippet.project_name or Path(filename).stem or "snippet",
            options=_analysis_options(),
            with_content=True,
        )
    except ImportValidationError as exc:
        raise HTTPException(status_code=exc.status_code, detail=exc.message)
    return _persist(result, snippet.source or "snippet")


# --------------------------------------------------------------------------- #
# Projects
# --------------------------------------------------------------------------- #

@app.get("/api/projects")
def list_projects() -> dict:
    projects = store.list_projects()
    return {"projects": projects, "count": len(projects)}


@app.get("/api/projects/{project_id}")
def get_project(project_id: str) -> dict:
    record = store.get_project(project_id)
    if record is None:
        raise HTTPException(status_code=404, detail="Project not found.")
    return record


@app.delete("/api/projects/{project_id}")
def delete_project(project_id: str) -> dict:
    if not store.delete_project(project_id):
        raise HTTPException(status_code=404, detail="Project not found.")
    return {"deleted": True, "id": project_id}


@app.get("/api/projects/{project_id}/file")
def get_project_file(project_id: str, path: str) -> dict:
    if store.get_project(project_id) is None:
        raise HTTPException(status_code=404, detail="Project not found.")
    content = store.read_project_file(project_id, path)
    if content is None:
        raise HTTPException(status_code=404, detail="File not found.")
    return {"path": path, "content": content}


@app.post("/api/projects/{project_id}/reanalyze")
def reanalyze_project(project_id: str) -> dict:
    record = store.get_project(project_id)
    if record is None:
        raise HTTPException(status_code=404, detail="Project not found.")

    files = store.read_project_files(project_id)
    if not files:
        raise HTTPException(status_code=400, detail="This project has no stored files to re-analyze.")

    collected = [(item["path"], item["content"].encode("utf-8")) for item in files]
    try:
        result = analyze_files(collected, record.get("name", ""), options=_analysis_options())
    except ImportValidationError as exc:
        raise HTTPException(status_code=exc.status_code, detail=exc.message)

    updates = {
        "file_count": result["file_count"],
        "total_size": result["total_size"],
        "total_lines": result["total_lines"],
        "detected_types": result["detected_types"],
        "files": [
            {
                "path": item["path"],
                "language": item["language"],
                "category": item.get("category", "Other"),
                "size": item["size"],
                "lines": 0,
            }
            for item in result["files"]
        ],
        "skipped": result["skipped"],
        "skipped_count": result["skipped_count"],
        "status": "analyzed",
        "analyzed_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
    }
    updated = store.update_project(project_id, **updates)
    (store.STORIES_DIR / f"{project_id}.json").unlink(missing_ok=True)
    return {"project": updated, "summary": result}


# --------------------------------------------------------------------------- #
# Static analysis: system map and issues
# --------------------------------------------------------------------------- #

@app.get("/api/projects/{project_id}/map")
def project_map(project_id: str) -> dict:
    if store.get_project(project_id) is None:
        raise HTTPException(status_code=404, detail="Project not found.")
    files = store.read_project_files(project_id)
    return static_analysis.build_map(files)


@app.get("/api/projects/{project_id}/issues")
def project_issues(project_id: str) -> dict:
    record = store.get_project(project_id)
    if record is None:
        raise HTTPException(status_code=404, detail="Project not found.")
    files = store.read_project_files(project_id)
    skipped = record.get("skipped", {}) if store.load_settings().get("flag_unsupported", True) else {
        key: value for key, value in record.get("skipped", {}).items() if key != "unsupported"
    }
    return static_analysis.detect_issues(files, skipped)


@app.get("/api/projects/{project_id}/visuals")
def project_visuals(project_id: str) -> dict:
    """Static diagram data (architecture, call graph, workflow) for the Story."""
    record = store.get_project(project_id)
    if record is None:
        raise HTTPException(status_code=404, detail="Project not found.")
    files = store.read_project_files(project_id)
    return visuals.build(record, files)


# --------------------------------------------------------------------------- #
# AI story generation (local Ollama, optional)
# --------------------------------------------------------------------------- #

@app.get("/api/projects/{project_id}/story")
def get_story(project_id: str) -> dict:
    if store.get_project(project_id) is None:
        raise HTTPException(status_code=404, detail="Project not found.")
    story = store.load_story(project_id)
    if story is None:
        return {"available": False, "story": None}
    return {"available": True, "story": story}


@app.post("/api/projects/{project_id}/story")
def create_story(project_id: str) -> dict:
    record = store.get_project(project_id)
    if record is None:
        raise HTTPException(status_code=404, detail="Project not found.")

    files = store.read_project_files(project_id)
    if not files:
        raise HTTPException(status_code=400, detail="This project has no stored files.")

    try:
        story = story_module.generate(record, files)
    except story_module.StoryError as exc:
        raise HTTPException(status_code=503, detail=exc.message)

    story["project_id"] = project_id
    store.save_story(project_id, story)
    return {"available": True, "story": story}


@app.get("/api/ai/status")
def ai_status() -> dict:
    return ollama.status()


# --------------------------------------------------------------------------- #
# Settings and data management
# --------------------------------------------------------------------------- #

@app.get("/api/settings")
def get_settings() -> dict:
    return {"settings": store.load_settings()}


@app.put("/api/settings")
def update_settings(update: SettingsUpdate) -> dict:
    payload = {key: value for key, value in update.dict().items() if value is not None}
    return {"settings": store.save_settings(payload)}


@app.delete("/api/data")
def clear_data() -> dict:
    store.clear_all()
    return {"cleared": True}


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="127.0.0.1", port=8000)
