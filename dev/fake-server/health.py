# Fake web app: 503 while in maintenance (/shared/down exists, created by `php artisan down`),
# 500 when "broken" (/shared/broken), otherwise 200.
import http.server
import os

NAME = os.environ.get("SERVER_NAME", "server")


class Handler(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        if os.path.exists("/shared/broken"):
            code, body = 500, b"Server Error"
        elif os.path.exists("/shared/down"):
            code, body = 503, b"Service Unavailable (maintenance)"
        else:
            code, body = 200, f"OK from {NAME} (Host: {self.headers.get('Host')})".encode()
        self.send_response(code)
        self.send_header("Content-Type", "text/plain")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *args):
        pass


http.server.ThreadingHTTPServer(("0.0.0.0", 80), Handler).serve_forever()
