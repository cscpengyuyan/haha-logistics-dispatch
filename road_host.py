"""Optional loopback worker for an operator-owned Valhalla graph and native VROOM."""
import argparse
import json
import subprocess
import sys
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path


def serve(config, port):
    from valhalla import Actor, __version__
    actor = Actor(str(config))

    class Worker(BaseHTTPRequestHandler):
        def answer(self, status, data):
            raw = json.dumps(data).encode()
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(raw)))
            self.end_headers()
            self.wfile.write(raw)

        def do_GET(self):
            if self.path == "/status":
                self.answer(200, {"version": __version__})
            else:
                self.answer(404, {"error": "Unknown operation"})

        def do_POST(self):
            try:
                size = int(self.headers.get("Content-Length", "0"))
                if not 0 < size <= 512000:
                    return self.answer(413, {"error": "Invalid request size"})
                req = json.loads(self.rfile.read(size))
                if self.path == "/":
                    child = subprocess.run(
                        [sys.executable, "-c", "import vroom; vroom.main(['vroom','-t','2'])"],
                        input=json.dumps(req).encode(), capture_output=True, timeout=20,
                        creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
                    result = json.loads(child.stdout)
                    if child.returncode:
                        return self.answer(422, result)
                elif self.path in ("/sources_to_targets", "/route"):
                    operation = actor.matrix if self.path == "/sources_to_targets" else actor.route
                    result = operation(req)
                else:
                    return self.answer(404, {"error": "Unknown operation"})
                self.answer(200, result)
            except (ValueError, RuntimeError, OSError, subprocess.TimeoutExpired) as error:
                self.answer(422, {"error": str(error)[:240]})

        def log_message(self, *args):
            pass

    with HTTPServer(("127.0.0.1", port), Worker) as httpd:
        print("Road worker listening on loopback", httpd.server_port, flush=True)
        httpd.serve_forever()


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("config", type=Path)
    parser.add_argument("--port", type=int, default=18802)
    args = parser.parse_args()
    serve(args.config, args.port)
