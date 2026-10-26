# Serves this folder with caching off. A cached page loads without a request,
# so a replayed navigate step would find none of the traffic it recorded.
# The /api routes give catalog.html's waiting and data-change rows real
# traffic to wait on: a short reply, a stream, a failure, a refusal and a push.
import functools, http.server, json, os, sys, time
from urllib.parse import urlparse, parse_qs

class Handler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header('Cache-Control', 'no-store')
        super().end_headers()

    def do_GET(self):
        url = urlparse(self.path)
        if url.path == '/api/messages':
            time.sleep(int(parse_qs(url.query).get('delay', ['60'])[0]) / 1000)
            return self.reply(200, ['Quarterly numbers', 'Lunch on Friday?', 'Build passed', 'Re: the motion bug'])
        if url.path == '/api/sync':
            chunk, count = b'x' * 4096, 16
            self.send_response(200)
            self.send_header('Content-Type', 'application/octet-stream')
            self.send_header('Content-Length', str(len(chunk) * count))
            self.end_headers()
            for _ in range(count):
                self.wfile.write(chunk)
                self.wfile.flush()
                time.sleep(0.1)
            return
        if url.path == '/api/events':
            self.send_response(200)
            self.send_header('Content-Type', 'text/event-stream')
            self.end_headers()
            for subject in ['Invoice #2231', 'Standup moved', 'Your parcel shipped', 'Password changed']:
                time.sleep(1.5)
                self.wfile.write(f'data: {subject}\n\n'.encode())
                self.wfile.flush()
            self.wfile.write(b'event: end\ndata: \n\n')
            self.wfile.flush()
            return
        super().do_GET()

    def do_POST(self):
        if urlparse(self.path).path == '/api/send':
            time.sleep(0.9)
            return self.reply(500, {'error': 'mailbox full'})
        if urlparse(self.path).path == '/api/star':
            time.sleep(0.5)
            return self.reply(409, {'error': 'already starred elsewhere'})
        self.send_error(404)

    # An aborted fetch closes the socket while the reply sleeps; the write
    # then raises, and the page has already moved on.
    def reply(self, status, body):
        data = json.dumps(body).encode()
        try:
            self.send_response(status)
            self.send_header('Content-Type', 'application/json')
            self.send_header('Content-Length', str(len(data)))
            self.end_headers()
            self.wfile.write(data)
        except (BrokenPipeError, ConnectionResetError):
            pass

port = int(sys.argv[1]) if len(sys.argv) > 1 else 4720
root = os.path.dirname(os.path.abspath(__file__))
server = http.server.ThreadingHTTPServer(('127.0.0.1', port), functools.partial(Handler, directory=root))
print(f'Serving on http://127.0.0.1:{port}/', flush=True)
server.serve_forever()
