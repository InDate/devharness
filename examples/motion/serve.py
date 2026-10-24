# Serves this folder with caching off. A cached page loads without a request,
# so a replayed navigate step would find none of the traffic it recorded.
import functools, http.server, os, sys

class NoStore(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header('Cache-Control', 'no-store')
        super().end_headers()

port = int(sys.argv[1]) if len(sys.argv) > 1 else 4720
root = os.path.dirname(os.path.abspath(__file__))
http.server.ThreadingHTTPServer(('127.0.0.1', port), functools.partial(NoStore, directory=root)).serve_forever()
