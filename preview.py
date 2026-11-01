"""Serve only public assets on localhost. No write API or shared database in this mode."""
from http.server import ThreadingHTTPServer,SimpleHTTPRequestHandler
from pathlib import Path
from urllib.parse import urlsplit,unquote
import argparse
from static_ranges import send_archive
PUBLIC=Path(__file__).resolve().parent/'v12'
class Handler(SimpleHTTPRequestHandler):
    def do_HEAD(self):
        path=unquote(urlsplit(self.path).path)
        file=(PUBLIC/path.removeprefix('/v12/')).resolve()
        if path.startswith('/v12/') and file.is_relative_to(PUBLIC) and file.is_file():
            if file.suffix=='.pmtiles':return send_archive(self,file)
            self.path=self.path[4:];return super().do_HEAD()
        self.send_error(404)
    def do_GET(self):
        req=unquote(urlsplit(self.path).path)
        if req in ('','/','/v12'):
            self.send_response(302);self.send_header('Location','/v12/');self.end_headers();return
        if not req.startswith('/v12/') or not (PUBLIC/req[5:]).resolve().is_relative_to(PUBLIC):self.send_error(404);return
        target=(PUBLIC/req[5:]).resolve()
        if target.is_file() and target.suffix==".pmtiles":
            return send_archive(self,target)
        self.path=self.path[4:];super().do_GET()
    def list_directory(self,path):self.send_error(404);return None
if __name__=='__main__':
    p=argparse.ArgumentParser();p.add_argument('--port',type=int,default=8766);a=p.parse_args()
    with ThreadingHTTPServer(('127.0.0.1',a.port),lambda *args:Handler(*args,directory=str(PUBLIC))) as s:
        print(f'http://127.0.0.1:{s.server_port}/v12/#tasks',flush=True);s.serve_forever()
