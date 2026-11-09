"""Serve Bean and retrieve public podcast feeds on the same origin."""
import argparse
import base64
import http.client
import ipaddress
import json
import socket
import ssl
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlencode, urljoin, urlsplit

ROOT = Path(__file__).resolve().parent / 'web'
LIMIT = 8 * 1024 * 1024
TLS = ssl.create_default_context()


def retrieve(url):
    for _ in range(6):
        target = urlsplit(url)
        if target.scheme not in ('https', 'http') or not target.hostname or target.username is not None:
            raise ValueError('Indirizzo non valido')
        port = 443 if target.scheme == 'https' else 80
        if target.port not in (None, port):
            raise ValueError('Porta non valida')
        addresses = socket.getaddrinfo(target.hostname, port, type=socket.SOCK_STREAM)
        public = []
        for *_, address in addresses:
            ip = ipaddress.ip_address(address[0])
            if ip.version == 6 and ip.ipv4_mapped:
                ip = ip.ipv4_mapped
            if ip.is_global and not ip.is_multicast:
                public.append(address[0])
        if not public:
            raise ValueError('Indirizzo non pubblico')
        connection = http.client.HTTPConnection(target.hostname, port, timeout=8)
        for address in dict.fromkeys(public):
            try:
                sock = socket.create_connection((address, port), timeout=5)
                break
            except OSError:
                continue
        else:
            raise OSError('Connessione non disponibile')
        try:
            connection.sock = sock
            if target.scheme == 'https':
                connection.sock = TLS.wrap_socket(sock, server_hostname=target.hostname)
            path = target.path or '/'
            if target.query:
                path += '?' + target.query
            connection.request('GET', path, headers={'User-Agent': 'Bean Podcast Player/0.1'})
            response = connection.getresponse()
            if response.status in (301, 302, 303, 307, 308) and response.getheader('Location'):
                url = urljoin(url, response.getheader('Location'))
                continue
            if response.status != 200:
                raise OSError(f'Risposta HTTP {response.status}')
            body = response.read(LIMIT + 1)
            if len(body) > LIMIT:
                raise ValueError('Feed troppo grande')
            return body, url
        finally:
            connection.close()
    raise ValueError('Troppi reindirizzamenti')


class Handler(SimpleHTTPRequestHandler):
    def do_GET(self):
        request = urlsplit(self.path)
        if request.path not in ('/api/search', '/api/feed'):
            return super().do_GET()
        args = parse_qs(request.query)
        try:
            if request.path == '/api/search':
                term = args.get('q', [''])[0].strip()[:120]
                query = urlencode(dict(term=term, country='IT', media='podcast', entity='podcast', limit=25))
                raw, _ = retrieve('https://itunes.apple.com/search?' + query)
                results = json.loads(raw)['results']
                payload = [
                    dict(title=item.get('collectionName') or item.get('trackName') or 'Podcast',
                         author=item.get('artistName', ''), feed=item['feedUrl'])
                    for item in results if item.get('feedUrl')
                ]
            else:
                raw, final_url = retrieve(args.get('url', [''])[0])
                payload = dict(xml=base64.b64encode(raw).decode('ascii'), url=final_url)
            self.respond(200, payload)
        except (OSError, ValueError, KeyError, http.client.HTTPException):
            self.respond(502, {'error': 'La fonte non ha risposto. Riprova tra poco.'})

    def respond(self, status, value):
        raw = json.dumps(value, ensure_ascii=False).encode('utf-8')
        self.send_response(status)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Content-Length', str(len(raw)))
        self.send_header('Cache-Control', 'no-store')
        self.end_headers()
        self.wfile.write(raw)


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--host', default='127.0.0.1')
    parser.add_argument('--port', type=int, default=8000)
    options = parser.parse_args()
    with ThreadingHTTPServer((options.host, options.port), partial(Handler, directory=ROOT)) as server:
        print(f'Bean in ascolto su {options.host}:{options.port}', flush=True)
        server.serve_forever()
