"""Local static server with correct MIME types for ES modules (Windows-safe).

Also serves the sibling Three.js editor under /editor/ + /build/ + /examples/ +
/files/ so it shares the origin with the game (no CORS), and exposes
POST /api/save-level so the editor's "Save Zombie Blaster Level" menu item can
persist edits straight into data/levelData.json.
"""
import errno
import http.server
import json
import os
import socketserver
import threading

# Always serve the game folder, even if the shell cwd is elsewhere (e.g. wrong terminal tab).
_ROOT = os.path.dirname(os.path.abspath(__file__))
os.chdir(_ROOT)

# Three.js editor checkout. Lives two levels up from this serve.py
# (Games/three.js_Editor, while we're at Games/ZombieBlaster/ZombieBlaster).
# Four URL prefixes get mapped onto its tree so the editor's importmap
# (../build/, ../examples/jsm/, ../files/) keeps working.
_EDITOR_ROOT = os.path.normpath(os.path.join(_ROOT, "..", "..", "three.js_Editor"))
_EDITOR_PREFIXES = ("/editor/", "/build/", "/examples/", "/files/", "/src/")


def _requested_port() -> int:
    return int(os.environ.get("PORT", "8080"))


def _addr_in_use(err: OSError) -> bool:
    if err.errno == errno.EADDRINUSE:
        return True
    # Windows: 10048 (address already in use), 10013 (access denied / port reserved
    # — fires when a port is in TIME_WAIT or in a kernel-reserved exclusion range).
    if getattr(err, "winerror", None) in (10013, 10048):
        return True
    return False


# Register before Windows mimetypes: stdlib checks extensions_map first (see guess_type).
_extensions = dict(http.server.SimpleHTTPRequestHandler.extensions_map)
_extensions.update(
    {
        ".js": "application/javascript",
        ".mjs": "application/javascript",
        ".wasm": "application/wasm",
    }
)


class Handler(http.server.SimpleHTTPRequestHandler):
    extensions_map = _extensions

    def translate_path(self, path: str) -> str:
        clean = path.split("?", 1)[0].split("#", 1)[0]
        # Bare "/editor" → redirect via the parent class would be cleaner, but
        # treating it as "/editor/" here gives the editor's index.html when the
        # user types just /editor.
        if clean == "/editor":
            clean = "/editor/"
        for prefix in _EDITOR_PREFIXES:
            if clean.startswith(prefix):
                rel = clean[1:]  # strip leading "/"
                # Build the on-disk path under _EDITOR_ROOT. normpath collapses
                # any "..", and the explicit startswith check below blocks
                # traversal outside the editor tree.
                candidate = os.path.normpath(os.path.join(_EDITOR_ROOT, *rel.split("/")))
                if candidate == _EDITOR_ROOT or candidate.startswith(_EDITOR_ROOT + os.sep):
                    return candidate
                # Path traversal attempt — fall through to default handler so
                # the request 404s against the game root.
                break
        return super().translate_path(path)

    def do_POST(self) -> None:
        path = self.path.split("?", 1)[0]
        if path != "/api/save-level":
            self.send_error(405, "Method Not Allowed")
            return

        length_hdr = self.headers.get("Content-Length")
        if not length_hdr:
            self.send_error(400, "Missing Content-Length")
            return
        try:
            n = int(length_hdr)
        except ValueError:
            self.send_error(400, "Bad Content-Length")
            return

        body = self.rfile.read(n)
        try:
            text = body.decode("utf-8")
        except UnicodeDecodeError:
            self.send_error(400, "Body must be UTF-8")
            return

        try:
            json.loads(text)
        except json.JSONDecodeError as e:
            self.send_response(400)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(
                json.dumps({"ok": False, "error": "Invalid JSON", "detail": str(e)}).encode("utf-8")
            )
            return

        out_path = os.path.join(_ROOT, "data", "levelData.json")
        tmp_path = out_path + ".tmp"
        # Serialize concurrent saves so the tmp-file + os.replace handoff
        # doesn't race under the threaded server.
        with self.server.save_lock:
            try:
                os.makedirs(os.path.dirname(out_path), exist_ok=True)
                with open(tmp_path, "w", encoding="utf-8", newline="\n") as f:
                    f.write(text)
                os.replace(tmp_path, out_path)
            except OSError as e:
                try:
                    if os.path.isfile(tmp_path):
                        os.remove(tmp_path)
                except OSError:
                    pass
                self.send_error(500, f"Write failed: {e}")
                return

        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.end_headers()
        self.wfile.write(b'{"ok":true}')


class _Server(http.server.ThreadingHTTPServer):
    # Default socketserver backlog is 5 — way too low for the editor's burst of
    # ~100 parallel module fetches. Without this, SYNs past 5 get RST'd by the
    # kernel and the browser sees ERR_CONNECTION_REFUSED on random files.
    request_queue_size = 256
    daemon_threads = True
    # Serialize writes to data/levelData.json across concurrent Save Level
    # POSTs so the tmp-file + os.replace handoff stays atomic.
    save_lock = threading.Lock()


def _bind_server(start_port: int, attempts: int = 30):
    """Return (server, actual_port). Tries start_port, start_port+1, … if busy.

    ThreadingHTTPServer (3.7+) handles each request in a thread, so the editor's
    parallel asset loads (~100 modules) don't queue up under HTTP/1.1 keep-alive.
    """
    last_err = None
    for p in range(start_port, start_port + attempts):
        try:
            return _Server(("", p), Handler), p
        except OSError as e:
            if _addr_in_use(e):
                last_err = e
                continue
            raise
    raise OSError(
        f"No free port in {start_port}–{start_port + attempts - 1}. "
        "Close the other server or set PORT to an open port."
    ) from last_err


if __name__ == "__main__":
    want = _requested_port()
    httpd, bound = _bind_server(want)
    with httpd:
        print()
        print("  Zombie Blaster — serve.py (ES module MIME types)")
        print("  Do not use: python -m http.server  (wrong Content-Type for .js on Windows)")
        if bound != want:
            print(f"  Port {want} was busy — using {bound} instead.")
        print(f"  http://localhost:{bound}/")
        print()
        httpd.serve_forever()

