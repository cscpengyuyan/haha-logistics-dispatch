"""Serve only public assets on localhost. No write API or shared database in this mode."""
from http.server import ThreadingHTTPServer,SimpleHTTPRequestHandler
from pathlib import Path
from urllib.parse import urlsplit,unquote
import argparse, os
from static_ranges import send_archive
VERSION=os.environ.get('HH_APP_VERSION','v13')
if VERSION not in ('v12','v13'): raise ValueError('HH_APP_VERSION must be v12 or v13')
PUBLIC=Path(__file__).resolve().parent/VERSION
PREFIX='/'+VERSION+'/'
class Handler(SimpleHTTPRequestHandler):
    def do_HEAD(self):
        path=unquote(urlsplit(self.path).path)
        file=(PUBLIC/path.removeprefix(PREFIX)).resolve()
        if path.startswith(PREFIX) and file.is_relative_to(PUBLIC) and file.is_file():
            if file.suffix=='.pmtiles':return send_archive(self,file)
            self.path=self.path[len(PREFIX)-1:];return super().do_HEAD()
        self.send_error(404)
    def do_GET(self):
        req=unquote(urlsplit(self.path).path)
        if req in ('','/','/'+VERSION):
            self.send_response(302);self.send_header('Location',PREFIX);self.end_headers();return
        if not req.startswith(PREFIX) or not (PUBLIC/req[len(PREFIX):]).resolve().is_relative_to(PUBLIC):self.send_error(404);return
        target=(PUBLIC/req[len(PREFIX):]).resolve()
        if target.is_file() and target.suffix==".pmtiles":
            return send_archive(self,target)
        self.path=self.path[len(PREFIX)-1:];super().do_GET()
    def list_directory(self,path):self.send_error(404);return None
if __name__=='__main__':
    p=argparse.ArgumentParser();p.add_argument('--port',type=int,default=8766);a=p.parse_args()
    with ThreadingHTTPServer(('127.0.0.1',a.port),lambda *args:Handler(*args,directory=str(PUBLIC))) as s:
        print(f'http://127.0.0.1:{s.server_port}/{VERSION}/#map',flush=True);s.serve_forever()
