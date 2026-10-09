"""CodeStory - backend/visuals.py

Static, verifiable data for the Story visuals: an architecture graph, a
symbol-level call graph, event-driven workflow lanes and (when the source
supports it) a point-of-sale journey.

Everything here is derived by reading source text. Imported code is never
executed. JavaScript gets a best-effort call graph; other languages only get
file-level relationships and symbol lists. Every edge carries the file and line
where it was found so the front end can show the evidence.
"""

from __future__ import annotations

import bisect
import posixpath
import re

import static_analysis
import story as story_module

JS_LANGUAGES = {"JavaScript", "TypeScript", "JavaScript (JSX)", "TypeScript (TSX)"}
JS_EXTENSIONS = (".js", ".mjs", ".cjs", ".ts", ".jsx", ".tsx")

SNIPPET_LINES = 12
MAX_FLOW_DEPTH = 5
MAX_FLOW_STEPS = 24
MAX_SYMBOLS = 400

IDENT = r"[A-Za-z_$][\w$]*"
KEYWORDS = {
    "if", "for", "while", "switch", "catch", "return", "function", "typeof", "new",
    "await", "async", "do", "else", "try", "finally", "throw", "case", "delete",
    "void", "in", "of", "instanceof", "yield", "super", "import", "export", "class",
    "const", "let", "var", "this", "true", "false", "null", "undefined", "default",
    "extends", "static", "get", "set", "constructor", "break", "continue", "with",
}

# --------------------------------------------------------------------------- #
# Secret redaction for any source text placed in visuals
# --------------------------------------------------------------------------- #

_SECRET_ASSIGN = re.compile(
    r"""(?ix)
    (\b[\w$.-]*(?:secret|token|passw(?:or)?d|api[_-]?key|private[_-]?key|access[_-]?key|auth[_-]?key|credential)[\w$-]*
      ["']?\s*[:=]\s*)
    (["'`])([^"'`\n]{4,})\2
    """
)
_SECRET_LITERALS = [
    re.compile(r"-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)"),
    re.compile(r"\bAKIA[0-9A-Z]{16}\b"),
    re.compile(r"\bgh[pousr]_[A-Za-z0-9]{30,}\b"),
    re.compile(r"\bsk-[A-Za-z0-9]{20,}\b"),
    re.compile(r"\bxox[abprs]-[A-Za-z0-9-]{10,}\b"),
]


def redact(text: str) -> str:
    """Mask values that look like credentials before they reach a visual."""
    if not text:
        return text
    text = _SECRET_ASSIGN.sub(lambda m: m.group(1) + m.group(2) + "[redacted]" + m.group(2), text)
    for pattern in _SECRET_LITERALS:
        text = pattern.sub("[redacted]", text)
    return text


# --------------------------------------------------------------------------- #
# JavaScript scanning helpers
# --------------------------------------------------------------------------- #

def _mask(src: str) -> str:
    """Blank out comments and string contents, keeping offsets and newlines."""
    out = list(src)
    i = 0
    n = len(src)
    while i < n:
        ch = src[i]
        nxt = src[i + 1] if i + 1 < n else ""
        if ch == "/" and nxt == "/":
            while i < n and src[i] != "\n":
                out[i] = " "
                i += 1
            continue
        if ch == "/" and nxt == "*":
            out[i] = out[i + 1] = " "
            i += 2
            while i < n and not (src[i] == "*" and i + 1 < n and src[i + 1] == "/"):
                if src[i] != "\n":
                    out[i] = " "
                i += 1
            if i < n:
                out[i] = " "
                if i + 1 < n:
                    out[i + 1] = " "
            i += 2
            continue
        if ch in ("'", '"', "`"):
            quote = ch
            i += 1
            while i < n and src[i] != quote:
                if src[i] == "\\" and i + 1 < n:
                    out[i] = " "
                    if src[i + 1] != "\n":
                        out[i + 1] = " "
                    i += 2
                    continue
                if src[i] == "\n" and quote != "`":
                    break
                if src[i] != "\n":
                    out[i] = " "
                i += 1
            i += 1
            continue
        i += 1
    return "".join(out)


def _match_brace(masked: str, open_index: int) -> int:
    pairs = {"{": "}", "[": "]", "(": ")"}
    opener = masked[open_index]
    closer = pairs.get(opener)
    if not closer:
        return -1
    depth = 0
    for index in range(open_index, len(masked)):
        char = masked[index]
        if char == opener:
            depth += 1
        elif char == closer:
            depth -= 1
            if depth == 0:
                return index
    return -1


class _Lines:
    def __init__(self, text: str):
        self.starts = [0]
        for index, char in enumerate(text):
            if char == "\n":
                self.starts.append(index + 1)

    def line(self, offset: int) -> int:
        return bisect.bisect_right(self.starts, offset)


def _snippet(content: str, start: int, end: int | None = None, max_lines: int = SNIPPET_LINES) -> dict:
    lines = content.splitlines()
    if start < 1 or start > len(lines):
        return {"text": "", "start": start, "truncated": False}
    last = len(lines) if end is None else min(end, len(lines))
    stop = min(last, start - 1 + max_lines)
    chunk = lines[start - 1:stop]
    indents = [len(line) - len(line.lstrip()) for line in chunk if line.strip()]
    strip = min(indents) if indents else 0
    chunk = [line[strip:] if len(line) >= strip else line.lstrip() for line in chunk]
    return {"text": redact("\n".join(chunk).rstrip()), "start": start, "truncated": stop < last}


# --------------------------------------------------------------------------- #
# Module parsing
# --------------------------------------------------------------------------- #

_IMPORT_NAMED = re.compile(r"\bimport\s+(?:(" + IDENT + r")\s*,\s*)?\{([^}]*)\}\s*from\s*['\"]([^'\"]+)['\"]")
_IMPORT_DEFAULT = re.compile(r"\bimport\s+(" + IDENT + r")\s+from\s*['\"]([^'\"]+)['\"]")
_IMPORT_NAMESPACE = re.compile(r"\bimport\s+\*\s+as\s+(" + IDENT + r")\s+from\s*['\"]([^'\"]+)['\"]")
_REQUIRE = re.compile(r"\b(?:const|let|var)\s+(?:(" + IDENT + r")|\{([^}]*)\})\s*=\s*require\(\s*['\"]([^'\"]+)['\"]\s*\)")

_CLASS = re.compile(r"\bclass\s+(" + IDENT + r")(?:\s+extends\s+[\w$.]+)?\s*\{")
_METHOD = re.compile(r"(?m)^[ \t]*(?:static\s+|async\s+|get\s+|set\s+)*(" + IDENT + r")\s*\([^()]*\)\s*\{")
_FUNCTION = re.compile(r"\b(?:async\s+)?function\s*\*?\s*(" + IDENT + r")\s*\([^()]*\)\s*\{")
_ARROW = re.compile(
    r"\b(?:const|let|var)\s+(" + IDENT + r")\s*=\s*(?:async\s+)?"
    r"(?:function\b[^{(]*\([^()]*\)\s*|\([^()]*\)\s*=>\s*|" + IDENT + r"\s*=>\s*)\{"
)
_CONST = re.compile(r"(?m)^(export\s+)?(?:const|let|var)\s+(" + IDENT + r")\s*=\s*")
_EXPORT_DECL = re.compile(r"\bexport\s+(?:default\s+)?(?:async\s+)?(?:function\s*\*?|class|const|let|var)\s+(" + IDENT + r")")
_EXPORT_LIST = re.compile(r"\bexport\s*\{([^}]*)\}")
_INSTANCE = re.compile(r"\b(?:const|let|var)\s+(" + IDENT + r")\s*=\s*new\s+(" + IDENT + r")\s*\(")
_ELEMENT = re.compile(
    r"\b(?:const|let|var)\s+(" + IDENT + r")\s*=\s*document\s*\.\s*"
    r"(getElementById|querySelector)\(\s*['\"]([^'\"]+)['\"]\s*\)"
)
_LISTENER = re.compile(r"(" + IDENT + r")\s*\.\s*addEventListener\(\s*['\"`]([^'\"`\n]*)['\"`]\s*,\s*")
_INLINE_HANDLER = re.compile(
    r"(?:async\s+)?(?:function\s*(?:" + IDENT + r")?\s*\([^()]*\)|\([^()]*\)\s*=>|" + IDENT + r"\s*=>)\s*\{"
)
_NAMED_HANDLER = re.compile(r"(" + IDENT + r"(?:\." + IDENT + r")?)\s*[,)]")
_CLOSEST = re.compile(r"\.\s*(?:closest|matches)\(\s*['\"]([^'\"]+)['\"]\s*\)")
_MEMBER_CALL = re.compile(r"(?<![\w$])(" + IDENT + r")\s*\.\s*(" + IDENT + r")\s*\(")
_PLAIN_CALL = re.compile(r"(?<![\w$.])(new\s+)?(" + IDENT + r")\s*\(")
_IDENT_REF = re.compile(r"(?<![\w$.])(" + IDENT + r")(?![\w$])")


def _names_list(raw: str) -> list[tuple[str, str]]:
    """Parse `a, b as c` into [(imported, local)]."""
    pairs = []
    for part in raw.split(","):
        part = part.strip()
        if not part:
            continue
        bits = re.split(r"\s+as\s+|\s*:\s*", part)
        imported = bits[0].strip()
        local = bits[-1].strip()
        if re.fullmatch(IDENT, imported) and re.fullmatch(IDENT, local):
            pairs.append((imported, local))
    return pairs


class _Module:
    def __init__(self, path: str, content: str):
        self.path = path
        self.content = content
        self.masked = _mask(content)
        self.lines = _Lines(content)
        self.symbols: dict[str, dict] = {}
        self.ranges: list[tuple[int, int, str]] = []
        self.imports: list[dict] = []
        self.exports: set[str] = set()
        self.instances: dict[str, str] = {}
        self.elements: dict[str, dict] = {}
        self.listeners: list[dict] = []
        self.class_ranges: list[tuple[int, int, str]] = []
        self.import_spans: list[tuple[int, int]] = []

    def in_import(self, offset: int) -> bool:
        return any(a <= offset < b for a, b in self.import_spans)

    def visible(self, offset: int) -> bool:
        return self.masked[offset] == self.content[offset]

    def add_symbol(self, name: str, qualified: str, kind: str, start: int, body_open: int | None,
                   body_close: int | None, **extra) -> dict:
        sid = f"{self.path}#{qualified}"
        if sid in self.symbols:
            return self.symbols[sid]
        line = self.lines.line(start)
        end_line = self.lines.line(body_close) if body_close is not None and body_close >= 0 else line
        symbol = {
            "id": sid, "file": self.path, "name": name, "qualified": qualified,
            "kind": kind, "line": line, "end_line": end_line, **extra,
        }
        self.symbols[sid] = symbol
        if body_open is not None and body_close is not None and body_close > body_open:
            self.ranges.append((body_open, body_close, sid))
        return symbol

    def parse(self) -> None:
        masked = self.masked
        content = self.content

        for regex in (_IMPORT_NAMESPACE, _IMPORT_NAMED, _IMPORT_DEFAULT, _REQUIRE, _EXPORT_LIST):
            for match in regex.finditer(content):
                if self.visible(match.start()):
                    self.import_spans.append((match.start(), match.end()))
        for match in _IMPORT_NAMESPACE.finditer(content):
            if self.visible(match.start()):
                self.imports.append({"spec": match.group(2), "names": [("*", match.group(1))],
                                     "line": self.lines.line(match.start()), "namespace": True})
        for match in _IMPORT_NAMED.finditer(content):
            if self.visible(match.start()):
                names = _names_list(match.group(2))
                if match.group(1):
                    names.insert(0, ("default", match.group(1)))
                self.imports.append({"spec": match.group(3), "names": names,
                                     "line": self.lines.line(match.start())})
        for match in _IMPORT_DEFAULT.finditer(content):
            if self.visible(match.start()):
                self.imports.append({"spec": match.group(2), "names": [("default", match.group(1))],
                                     "line": self.lines.line(match.start())})
        for match in _REQUIRE.finditer(content):
            if self.visible(match.start()):
                names = [("*", match.group(1))] if match.group(1) else _names_list(match.group(2) or "")
                self.imports.append({"spec": match.group(3), "names": names,
                                     "line": self.lines.line(match.start()), "namespace": bool(match.group(1))})

        for match in _EXPORT_DECL.finditer(masked):
            self.exports.add(match.group(1))
        for match in _EXPORT_LIST.finditer(masked):
            for _imported, local in _names_list(match.group(1)):
                self.exports.add(local)

        for match in _CLASS.finditer(masked):
            name = match.group(1)
            open_index = match.end() - 1
            close_index = _match_brace(masked, open_index)
            if close_index < 0:
                continue
            self.add_symbol(name, name, "class", match.start(), None, close_index,
                            exported=name in self.exports)
            self.class_ranges.append((open_index, close_index, name))
            body = masked[open_index + 1:close_index]
            depth_at = []
            depth = 0
            for char in body:
                depth_at.append(depth)
                if char in "{([":
                    depth += 1
                elif char in "})]":
                    depth -= 1
            for method in _METHOD.finditer(body):
                method_name = method.group(1)
                name_offset = method.start(1)
                if method_name in KEYWORDS - {"constructor"} or depth_at[name_offset] != 0:
                    continue
                m_open = open_index + 1 + method.end() - 1
                m_close = _match_brace(masked, m_open)
                self.add_symbol(method_name, f"{name}.{method_name}", "method",
                                open_index + 1 + name_offset, m_open, m_close, owner=name)

        in_class = lambda offset: any(a < offset < b for a, b, _ in self.class_ranges)  # noqa: E731

        for match in _FUNCTION.finditer(masked):
            name = match.group(1)
            if name in KEYWORDS:
                continue
            open_index = match.end() - 1
            self.add_symbol(name, name, "function", match.start(), open_index,
                            _match_brace(masked, open_index), exported=name in self.exports)
        for match in _ARROW.finditer(masked):
            name = match.group(1)
            if in_class(match.start()):
                continue
            open_index = match.end() - 1
            self.add_symbol(name, name, "function", match.start(), open_index,
                            _match_brace(masked, open_index), exported=name in self.exports)

        for match in _CONST.finditer(masked):
            name = match.group(2)
            sid = f"{self.path}#{name}"
            if sid in self.symbols or not (match.group(1) or name in self.exports):
                continue
            value_start = match.end()
            rest = masked[value_start:value_start + 40]
            if re.match(r"(?:async\s+)?(?:function\b|\([^()]*\)\s*=>|" + IDENT + r"\s*=>|new\s)", rest):
                continue
            close = value_start
            if value_start < len(masked) and masked[value_start] in "[{(":
                close = _match_brace(masked, value_start)
                if close < 0:
                    close = value_start
            self.add_symbol(name, name, "constant", match.start(), None, close, exported=True)

        for match in _INSTANCE.finditer(masked):
            self.instances[match.group(1)] = match.group(2)
        for match in _ELEMENT.finditer(content):
            if self.visible(match.start()):
                selector = match.group(3)
                element_id = selector if match.group(2) == "getElementById" else (
                    selector[1:] if re.fullmatch(r"#[\w-]+", selector) else None)
                self.elements[match.group(1)] = {"selector": selector if match.group(2) != "getElementById" else "#" + selector,
                                                 "id": element_id}

        for match in _LISTENER.finditer(masked):
            target, event = match.group(1), self.content[match.start(2):match.end(2)].strip()
            if not re.fullmatch(r"[\w:-]+", event):
                continue
            after = match.end()
            line = self.lines.line(match.start())
            inline = _INLINE_HANDLER.match(masked, after)
            listener = {"target": target, "event": event, "line": line, "offset": match.start()}
            if inline:
                open_index = inline.end() - 1
                close_index = _match_brace(masked, open_index)
                qualified = f"on:{target}:{event}:{line}"
                label = f"{target} {event} handler"
                self.add_symbol(label, qualified, "handler", match.start(), open_index, close_index)
                listener["handler"] = f"{self.path}#{qualified}"
                body = content[open_index:close_index] if close_index > 0 else ""
                listener["selectors"] = sorted(set(_CLOSEST.findall(body)))
            else:
                named = _NAMED_HANDLER.match(masked, after)
                if named:
                    listener["handler_name"] = named.group(1)
                listener["selectors"] = []
            self.listeners.append(listener)

    def enclosing(self, offset: int) -> str | None:
        best = None
        best_size = None
        for start, end, sid in self.ranges:
            if start < offset < end and (best_size is None or end - start < best_size):
                best, best_size = sid, end - start
        return best

    def class_at(self, offset: int) -> str | None:
        for start, end, name in self.class_ranges:
            if start < offset < end:
                return name
        return None


# --------------------------------------------------------------------------- #
# Graph construction
# --------------------------------------------------------------------------- #

def _resolver(files: list[dict]):
    path_lookup = {item["path"]: item["path"] for item in files}
    stem_lookup: dict[str, list[str]] = {}
    for item in files:
        stem = posixpath.splitext(posixpath.basename(item["path"]))[0].lower()
        stem_lookup.setdefault(stem, []).append(item["path"])

    def resolve(spec: str, source: str) -> str | None:
        return static_analysis._resolve(spec, source, path_lookup, stem_lookup)

    return resolve


def _reference_line(content: str, target: str, source: str) -> tuple[int | None, str]:
    """Find the statement in `source` that references `target`."""
    base = posixpath.basename(target)
    stem = posixpath.splitext(base)[0]
    for number, line in enumerate(content.splitlines(), 1):
        if base in line or re.search(r"['\"][^'\"]*\b" + re.escape(stem) + r"['\"]", line):
            stripped = line.strip()
            if re.search(r"<script|<link|<img|import|require|include|from|@import", stripped, re.IGNORECASE):
                return number, redact(stripped[:200])
    return None, ""


def _element_locations(files: list[dict]) -> dict[str, dict]:
    found: dict[str, dict] = {}
    for item in files:
        if not item["path"].lower().endswith((".html", ".htm")):
            continue
        for number, line in enumerate(item.get("content", "").splitlines(), 1):
            for element_id in re.findall(r"\bid\s*=\s*['\"]([^'\"]+)['\"]", line):
                found.setdefault(element_id, {"file": item["path"], "line": number})
    return found


def build(record: dict, files: list[dict]) -> dict:
    """Return verified visual data for a stored project."""
    graph = static_analysis.build_map(files)
    resolve = _resolver(files)
    by_path = {item["path"]: item for item in files}

    modules: dict[str, _Module] = {}
    for item in files:
        path = item["path"]
        if item.get("language") in JS_LANGUAGES or path.lower().endswith(JS_EXTENSIONS):
            module = _Module(path, item.get("content", ""))
            try:
                module.parse()
            except (IndexError, RecursionError):
                continue
            modules[path] = module

    # Import bindings: local name -> (target path, imported name)
    bindings: dict[str, dict[str, tuple[str, str, int]]] = {}
    import_names: dict[tuple[str, str], dict] = {}
    for path, module in modules.items():
        local_bindings: dict[str, tuple[str, str, int]] = {}
        for imp in module.imports:
            target = resolve(imp["spec"], path)
            if not target:
                continue
            entry = import_names.setdefault((path, target), {"names": [], "line": imp["line"]})
            for imported, local in imp["names"]:
                local_bindings[local] = (target, imported, imp["line"])
                if imported != "*":
                    entry["names"].append(imported)
                else:
                    entry["names"].append("* as " + local)
        bindings[path] = local_bindings

    symbols: dict[str, dict] = {}
    for module in modules.values():
        symbols.update(module.symbols)

    def lookup(path: str, qualified: str) -> str | None:
        sid = f"{path}#{qualified}"
        return sid if sid in symbols else None

    def resolve_name(path: str, name: str) -> str | None:
        local = lookup(path, name)
        if local:
            return local
        binding = bindings.get(path, {}).get(name)
        if binding and binding[1] not in ("*", "default"):
            return lookup(binding[0], binding[1])
        return None

    def class_of(path: str, var: str, offset: int) -> tuple[str, str] | None:
        module = modules[path]
        class_name = None
        if var == "this":
            class_name = module.class_at(offset)
            if class_name:
                return path, class_name
            return None
        if var in module.instances:
            class_name = module.instances[var]
        elif lookup(path, var) and symbols[f"{path}#{var}"]["kind"] == "class":
            class_name = var
        elif var in bindings.get(path, {}):
            target, imported, _ = bindings[path][var]
            if lookup(target, imported) and symbols[f"{target}#{imported}"]["kind"] == "class":
                return target, imported
        if not class_name:
            return None
        if lookup(path, class_name):
            return path, class_name
        binding = bindings.get(path, {}).get(class_name)
        if binding and lookup(binding[0], binding[1]):
            return binding[0], binding[1]
        return None

    calls: list[dict] = []
    seen_calls: set[tuple] = set()

    def add_call(source: str, target: str, kind: str, path: str, line: int) -> None:
        if source == target:
            return
        key = (source, target, kind)
        if key in seen_calls:
            return
        seen_calls.add(key)
        calls.append({"from": source, "to": target, "kind": kind, "file": path, "line": line})

    module_symbols: dict[str, str] = {}
    for path, module in modules.items():
        masked = module.masked
        listener_spans = []
        for listener in module.listeners:
            end = masked.find(")", listener["offset"])
            handler = listener.get("handler")
            if handler:
                span_end = next((b for a, b, sid in module.ranges if sid == handler), end)
                listener_spans.append((listener["offset"], span_end))
            else:
                listener_spans.append((listener["offset"], end))

        def owner(offset: int) -> str:
            enclosing = module.enclosing(offset)
            if enclosing:
                return enclosing
            sid = f"{path}#(module)"
            if sid not in symbols:
                symbols[sid] = {"id": sid, "file": path, "name": "module setup", "qualified": "(module)",
                                "kind": "module", "line": 1, "end_line": module.lines.line(len(module.content))}
                module_symbols[path] = sid
            return sid

        decl_offsets = set()
        for regex in (_FUNCTION, _ARROW):
            for match in regex.finditer(masked):
                decl_offsets.add(match.start(1))
        for start, end, _name in module.class_ranges:
            body = masked[start + 1:end]
            for method in _METHOD.finditer(body):
                decl_offsets.add(start + 1 + method.start(1))

        called_positions: set[int] = set()
        for match in _MEMBER_CALL.finditer(masked):
            obj, method = match.group(1), match.group(2)
            offset = match.start(2)
            called_positions.add(match.start(1))
            line = module.lines.line(offset)
            resolved_class = class_of(path, obj, offset)
            target = None
            if resolved_class:
                target = lookup(resolved_class[0], f"{resolved_class[1]}.{method}")
            elif obj in bindings.get(path, {}) and bindings[path][obj][1] == "*":
                target = lookup(bindings[path][obj][0], method)
            if target:
                add_call(owner(offset), target, "call", path, line)

        for match in _PLAIN_CALL.finditer(masked):
            name = match.group(2)
            offset = match.start(2)
            if name in KEYWORDS or offset in decl_offsets:
                continue
            called_positions.add(offset)
            target = resolve_name(path, name)
            if not target:
                continue
            line = module.lines.line(offset)
            if match.group(1):
                add_call(owner(offset), target, "instantiates", path, line)
                ctor = lookup(symbols[target]["file"], symbols[target]["qualified"] + ".constructor")
                if ctor:
                    add_call(owner(offset), ctor, "call", path, line)
            elif symbols[target]["kind"] != "class":
                add_call(owner(offset), target, "call", path, line)

        for listener in module.listeners:
            name = listener.get("handler_name")
            if name and not listener.get("handler"):
                target = resolve_name(path, name)
                if not target and "." in name:
                    obj, method = name.split(".", 1)
                    resolved_class = class_of(path, obj, listener["offset"])
                    if resolved_class:
                        target = lookup(resolved_class[0], f"{resolved_class[1]}.{method}")
                listener["handler"] = target

        for match in _IDENT_REF.finditer(masked):
            name = match.group(1)
            offset = match.start(1)
            if name in KEYWORDS or offset in called_positions or offset in decl_offsets or module.in_import(offset):
                continue
            target = resolve_name(path, name)
            if not target:
                continue
            kind = symbols[target]["kind"]
            source = owner(offset)
            if source == target:
                continue
            if any(a <= offset <= b for a, b in listener_spans) and source == module_symbols.get(path):
                continue
            # Skip the identifier in its own declaration line.
            if symbols[target]["file"] == path and module.lines.line(offset) == symbols[target]["line"]:
                continue
            if module.content[match.end(1):match.end(1) + 1] == ":" and module.content[offset - 1:offset] in ("{", " ", ","):
                if re.match(r"\s*\{|,\s*$", module.content[max(0, offset - 3):offset]):
                    continue
            line = module.lines.line(offset)
            if kind == "constant":
                add_call(source, target, "reads", path, line)
            elif kind in ("function", "method"):
                add_call(source, target, "callback", path, line)

    # Entry points: event listeners + module setup code.
    element_html = _element_locations(files)
    entries: list[dict] = []
    for path, module in modules.items():
        if f"{path}#(module)" in symbols and any(c["from"] == f"{path}#(module)" and c["kind"] in ("call", "callback") for c in calls):
            entries.append({"id": f"{path}#(module)", "kind": "load", "file": path, "line": 1,
                            "label": f"{posixpath.basename(path)} loads", "handler": f"{path}#(module)"})
        for listener in module.listeners:
            if not listener.get("handler"):
                continue
            element = module.elements.get(listener["target"], {})
            location = element_html.get(element.get("id") or "") if element else None
            entries.append({
                "id": f"{path}#entry:{listener['line']}",
                "kind": "event",
                "event": listener["event"],
                "target": listener["target"],
                "element": element.get("selector"),
                "element_location": location,
                "selectors": listener.get("selectors", []),
                "file": path,
                "line": listener["line"],
                "label": f"{listener['event']} on {element.get('selector') or listener['target']}",
                "handler": listener["handler"],
            })

    calls.sort(key=lambda c: (c["from"], c["line"]))
    outgoing: dict[str, list[dict]] = {}
    for call in calls:
        outgoing.setdefault(call["from"], []).append(call)

    flows = []
    for entry in entries:
        steps = []
        visited: set[str] = set()

        def walk(sid: str, depth: int, via: dict | None) -> None:
            if len(steps) >= MAX_FLOW_STEPS or sid in visited:
                return
            visited.add(sid)
            steps.append({"symbol": sid, "depth": depth,
                          "via": {"kind": via["kind"], "file": via["file"], "line": via["line"]} if via else None})
            if depth >= MAX_FLOW_DEPTH:
                return
            for call in outgoing.get(sid, []):
                if call["kind"] in ("call", "callback", "instantiates") and symbols[call["to"]]["kind"] != "class":
                    walk(call["to"], depth + 1, call)

        walk(entry["handler"], 0, None)
        flows.append({"entry": entry["id"], "steps": steps})

    # Attach snippets (redacted) to the symbols that appear in the graph.
    used = {c["from"] for c in calls} | {c["to"] for c in calls} | {e["handler"] for e in entries}
    for sid, symbol in symbols.items():
        if symbol["kind"] == "module":
            continue
        if sid in used or symbol.get("exported") or symbol["kind"] in ("function", "method", "class"):
            content = by_path[symbol["file"]].get("content", "")
            symbol["snippet"] = _snippet(content, symbol["line"], symbol["end_line"])

    # Architecture: build_map plus imported names and statement lines.
    arch_edges = []
    for edge in graph.get("edges", []):
        source_content = by_path.get(edge["from"], {}).get("content", "")
        names_info = import_names.get((edge["from"], edge["to"]))
        if names_info:
            line = names_info["line"]
            statement = redact(source_content.splitlines()[line - 1].strip()[:200]) if line else ""
        else:
            line, statement = _reference_line(source_content, edge["to"], edge["from"])
        arch_edges.append({
            "from": edge["from"], "to": edge["to"], "kind": edge.get("kind", "references"),
            "names": (names_info or {}).get("names", []), "line": line, "statement": statement,
        })

    file_symbols: dict[str, list[dict]] = {}
    for item in files:
        path = item["path"]
        if path in modules:
            listed = [
                {"id": s["id"], "name": s["qualified"], "kind": s["kind"], "line": s["line"]}
                for s in modules[path].symbols.values() if s["kind"] != "handler"
            ]
        else:
            listed = [
                {"id": None, "name": s["name"], "kind": s["kind"], "line": s["line"]}
                for s in story_module.extract_symbols(item.get("content", ""), item.get("language", ""))
            ]
        file_symbols[path] = sorted(listed, key=lambda s: s["line"])

    nodes = []
    for node in graph.get("nodes", []):
        nodes.append({**node, "lines": len(by_path.get(node["path"], {}).get("content", "").splitlines()),
                      "symbols": file_symbols.get(node["path"], [])})

    if len(symbols) > MAX_SYMBOLS:
        keep = used
        symbols = {sid: s for sid, s in symbols.items() if sid in keep}

    journey = _journey(symbols, calls, entries, flows, modules)

    return {
        "generated": True,
        "architecture": {"nodes": nodes, "edges": arch_edges, "legend": graph.get("legend", [])},
        "symbols": symbols,
        "calls": calls,
        "entries": entries,
        "flows": flows,
        "journey": journey,
        "traced_languages": ["JavaScript"] if modules else [],
        "notes": (
            "Derived by static reading of the source: file links come from import, "
            "script and stylesheet references; function links come from call sites "
            "found in JavaScript. Dynamic dispatch, callbacks passed through "
            "variables and code in other languages are not traced."
        ),
    }


# --------------------------------------------------------------------------- #
# Point-of-sale journey (only built when the source confirms each stage)
# --------------------------------------------------------------------------- #

POS_STAGES = [
    {"key": "catalogue", "title": "Products listed", "anchors": ["renderProducts", "productCard"]},
    {"key": "select", "title": "Product selected", "anchors": ["Cart.add"]},
    {"key": "cart", "title": "Cart updated", "anchors": ["renderCart", "Cart.items"]},
    {"key": "totals", "title": "Totals calculated", "anchors": ["Cart.subtotal", "Cart.vat", "Cart.total"]},
    {"key": "checkout", "title": "Checkout", "anchors": ["checkout"]},
    {"key": "receipt", "title": "Receipt generated", "anchors": ["buildReceipt"]},
]
MIN_JOURNEY_STAGES = 4


def _journey(symbols: dict, calls: list[dict], entries: list[dict], flows: list[dict], modules: dict) -> dict | None:
    by_qualified: dict[str, list[str]] = {}
    for sid, symbol in symbols.items():
        by_qualified.setdefault(symbol["qualified"], []).append(sid)

    reach: dict[str, tuple[int, dict]] = {}
    entry_by_id = {entry["id"]: entry for entry in entries}
    for flow in flows:
        entry = entry_by_id[flow["entry"]]
        for step in flow["steps"]:
            current = reach.get(step["symbol"])
            if current is None or step["depth"] < current[0]:
                reach[step["symbol"]] = (step["depth"], entry)

    anchor_ids: set[str] = set()
    resolved = []
    for stage in POS_STAGES:
        ids = []
        for qualified in stage["anchors"]:
            matches = by_qualified.get(qualified, [])
            if len(matches) != 1 or matches[0] not in reach:
                ids = []
                break
            ids.append(matches[0])
        resolved.append(ids)
        anchor_ids.update(ids)

    outgoing: dict[str, list[dict]] = {}
    for call in calls:
        outgoing.setdefault(call["from"], []).append(call)

    stages = []
    shown: set[str] = set()
    for stage, ids in zip(POS_STAGES, resolved):
        if not ids:
            continue
        depth, entry = reach[ids[0]]
        trigger = None
        if entry["kind"] == "event" and depth <= 2:
            trigger = {
                "entry": entry["id"], "event": entry["event"], "element": entry.get("element"),
                "selectors": entry.get("selectors", []), "file": entry["file"], "line": entry["line"],
                "handler": entry["handler"],
            }
        evidence = []
        supporting = []
        for sid in ids:
            for call in outgoing.get(sid, []):
                if call["to"] in ids and call["kind"] != "reads":
                    evidence.append(call)
                elif (call["to"] not in anchor_ids and call["to"] not in shown and call["kind"] in ("call", "callback")
                      and call["to"] not in supporting and len(supporting) < 3):
                    supporting.append(call["to"])
        if trigger:
            for call in outgoing.get(trigger["handler"], []):
                if call["to"] in ids:
                    evidence.insert(0, call)
        shown.update(ids)
        shown.update(supporting)
        stages.append({
            "key": stage["key"], "title": stage["title"], "symbols": ids, "supporting": supporting,
            "trigger": trigger, "evidence": evidence, "reached_from": entry["id"],
        })

    if len(stages) < MIN_JOURNEY_STAGES:
        return None

    links = []
    earlier: set[str] = set()
    for previous, current in zip(stages, stages[1:]):
        earlier.update(previous["symbols"])
        earlier.update(previous["supporting"])
        prev_ids = set(previous["symbols"]) | set(previous["supporting"])
        if previous["trigger"]:
            prev_ids.add(previous["trigger"]["handler"])
        cur_ids = set(current["symbols"])
        call = next((c for c in calls if c["from"] in prev_ids and c["to"] in cur_ids and c["kind"] != "reads"), None)
        if call:
            links.append({"kind": "call", "verified": True, "from": call["from"], "to": call["to"],
                          "file": call["file"], "line": call["line"]})
            continue
        trigger = current["trigger"]
        link = {"kind": "user", "verified": False, "event": trigger["event"] if trigger else None,
                "element": trigger["element"] if trigger else None}
        if trigger:
            evidence = _dom_evidence(prev_ids, trigger, symbols, modules) or _dom_evidence(
                earlier - prev_ids, trigger, symbols, modules)
            if evidence:
                link.update(evidence)
                link["verified"] = True
        links.append(link)

    return {"profile": "point-of-sale", "stages": stages, "links": links}


def _dom_evidence(prev_ids: set[str], trigger: dict, symbols: dict, modules: dict) -> dict | None:
    """Show why a user action connects two stages, using real source lines."""
    needles = []
    for selector in trigger.get("selectors") or []:
        attribute = re.match(r"\[([\w-]+)", selector)
        if attribute:
            needles.append((attribute.group(1), "renders " + selector))
    target_var = None
    entry_module = modules.get(trigger["file"])
    if entry_module:
        for listener in entry_module.listeners:
            if listener["line"] == trigger["line"]:
                target_var = listener["target"]
    if target_var:
        needles.append((target_var, "updates " + target_var))
    for sid in sorted(prev_ids):
        symbol = symbols.get(sid)
        module = modules.get(symbol["file"]) if symbol else None
        if not module or symbol["kind"] == "module":
            continue
        lines = module.content.splitlines()
        for number in range(symbol["line"], min(symbol["end_line"], len(lines)) + 1):
            masked_line = module.masked.splitlines()[number - 1] if number - 1 < len(module.masked.splitlines()) else ""
            for needle, label in needles:
                text = lines[number - 1]
                if needle.startswith("data-") and needle in text:
                    return {"source": sid, "file": symbol["file"], "line": number, "detail": label}
                if not needle.startswith("data-") and re.search(r"(?<![\w$])" + re.escape(needle) + r"(?![\w$])", masked_line):
                    return {"source": sid, "file": symbol["file"], "line": number, "detail": label}
    return None
