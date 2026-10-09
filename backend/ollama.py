"""CodeStory - backend/ollama.py

Minimal client for a locally running Ollama server. Uses only the standard
library so no extra dependency is required. The host and model come from the
saved settings (falling back to defaults). Nothing is sent anywhere except the
configured local Ollama endpoint.
"""

from __future__ import annotations

import json
import urllib.error
import urllib.request

import store

CONNECT_ERROR = (
    "Could not reach Ollama. Make sure it is installed and running, then try "
    "again. Install from https://ollama.com/download and run: ollama serve"
)


def _host() -> str:
    return (store.load_settings().get("ollama_host") or "http://127.0.0.1:11434").rstrip("/")


def _model() -> str:
    return store.load_settings().get("ollama_model") or "qwen2.5-coder:3b"


def _request(path: str, payload: dict | None, timeout: float):
    url = f"{_host()}{path}"
    data = json.dumps(payload).encode("utf-8") if payload is not None else None
    request = urllib.request.Request(
        url,
        data=data,
        headers={"Content-Type": "application/json"},
        method="POST" if payload is not None else "GET",
    )
    with urllib.request.urlopen(request, timeout=timeout) as response:
        return json.loads(response.read().decode("utf-8"))


def status() -> dict:
    """Return the real connection status of the local Ollama server."""
    selected = _model()
    try:
        data = _request("/api/tags", None, timeout=4)
    except (urllib.error.URLError, urllib.error.HTTPError, OSError, ValueError) as error:
        return {
            "connected": False,
            "host": _host(),
            "model": selected,
            "models": [],
            "model_available": False,
            "error": CONNECT_ERROR if isinstance(error, urllib.error.URLError) else str(error),
        }

    models = [item.get("name", "") for item in data.get("models", [])]
    base = selected.split(":")[0]
    available = any(
        name == selected or name.split(":")[0] == base for name in models
    )
    return {
        "connected": True,
        "host": _host(),
        "model": selected,
        "models": models,
        "model_available": available,
        "error": None,
    }


def generate(
    prompt: str,
    model: str | None = None,
    timeout: float = 300,
    response_format: str | dict | None = "json",
) -> dict:
    """Generate a completion with Ollama (non-streaming)."""
    chosen = model or _model()
    payload = {
        "model": chosen,
        "prompt": prompt,
        "format": response_format,
        "stream": False,
        "options": {"temperature": 0.2},
    }
    try:
        data = _request("/api/generate", payload, timeout=timeout)
    except urllib.error.HTTPError as error:
        detail = ""
        try:
            detail = error.read().decode("utf-8", "replace")
        except OSError:
            pass
        return {"ok": False, "model": chosen, "error": f"Ollama HTTP {error.code}: {detail[:300]}"}
    except (urllib.error.URLError, OSError, ValueError) as error:
        return {
            "ok": False,
            "model": chosen,
            "error": CONNECT_ERROR if isinstance(error, urllib.error.URLError) else str(error),
        }

    return {"ok": True, "model": chosen, "text": data.get("response", ""), "error": None}
