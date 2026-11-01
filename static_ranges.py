"""Serve a single byte range for a local immutable map archive."""
import re


def send_archive(handler, file):
    size = file.stat().st_size
    header = handler.headers.get("Range")
    match = re.fullmatch(r"bytes=(\d*)-(\d*)", header or "")
    start, end = 0, size - 1
    if header:
        if match and (match[1] or match[2]):
            if match[1]:
                start = int(match[1])
                end = min(int(match[2]), end) if match[2] else end
            else:
                start = max(size - int(match[2]), 0)
        else:
            start = size
    if start > end:
        handler.send_response(416)
        handler.send_header("Content-Range", f"bytes */{size}")
        handler.send_header("Content-Length", "0")
        handler.end_headers()
        return
    handler.send_response(206 if header else 200)
    handler.send_header("Accept-Ranges", "bytes")
    handler.send_header("Content-Type", "application/octet-stream")
    handler.send_header("Content-Length", str(end - start + 1))
    handler.send_header("X-Content-Type-Options", "nosniff")
    if header:
        handler.send_header("Content-Range", f"bytes {start}-{end}/{size}")
    handler.end_headers()
    if handler.command == "HEAD":
        return
    with file.open("rb") as stream:
        stream.seek(start)
        left = end - start + 1
        while left:
            chunk = stream.read(min(left, 65536))
            if not chunk:
                break
            handler.wfile.write(chunk)
            left -= len(chunk)
