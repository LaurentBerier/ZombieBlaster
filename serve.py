"""Local static server with correct MIME types for ES modules (Windows-safe)."""
import errno
import http.server
import os
import socketserver

# Always serve the game folder, even if the shell cwd is elsewhere (e.g. wrong terminal tab).
_ROOT = os.path.dirname(os.path.abspath(__file__))
os.chdir(_ROOT)


def _requested_port() -> int:
    return int(os.environ.get("PORT", "8080"))


def _addr_in_use(err: OSError) -> bool:
    if err.errno == errno.EADDRINUSE:
        return True
    # Windows: [WinError 10048] address already in use
    if getattr(err, "winerror", None) == 10048:
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


def _bind_server(start_port: int, attempts: int = 30):
    """Return (TCPServer, actual_port). Tries start_port, start_port+1, … if busy."""
    last_err = None
    for p in range(start_port, start_port + attempts):
        try:
            return socketserver.TCPServer(("", p), Handler), p
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
