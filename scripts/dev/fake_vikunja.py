#!/usr/bin/env python3
"""A stand-in Vikunja for gateway and Omi tests without Docker: the REST the gateway reads
and writes (/api/v2 projects and tasks) and the CalDAV Omi syncs with (/dav, VTODO only,
Basic auth, 404 on MKCALENDAR, one calendar per project), on one port, in memory.

    python3 scripts/dev/fake_vikunja.py --port 8901 --user omi --password pw --token tok

Tasks created over REST appear as VTODOs in their project's calendar and VTODOs PUT over
CalDAV appear as REST tasks, which is what Vikunja does. Only what the gateway and Omi use
is modelled; see the handlers for the exact subset.
"""

import argparse
import base64
import json
import re
import threading
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse
from xml.sax.saxutils import escape

PROJECTS = [{'id': 1, 'title': 'Inbox', 'is_archived': False}, {'id': 2, 'title': 'Family', 'is_archived': False}]
TASKS = {}  # id -> task dict (REST shape) + '_ics' (CalDAV object text) + '_name' (object file name)
LOCK = threading.Lock()
STATE = {'next_id': 1, 'user': 'omi', 'password': 'pw', 'token': 'tok', 'log': []}
ZERO = '0001-01-01T00:00:00Z'


def now_iso():
    return datetime.now(timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')


def ical_dt(value):
    if not value or value.startswith('0001'):
        return ''
    dt = datetime.fromisoformat(value.replace('Z', '+00:00')).astimezone(timezone.utc)
    return dt.strftime('%Y%m%dT%H%M%SZ')


def task_to_ics(t):
    lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//fake-vikunja//EN', 'BEGIN:VTODO', f'UID:{t["_uid"]}',
             f'DTSTAMP:{ical_dt(now_iso())}', f'SUMMARY:{t["title"]}']
    if t.get('description'):
        lines.append('DESCRIPTION:' + t['description'].replace('\n', '\\n'))
    if t.get('due_date') and not t['due_date'].startswith('0001'):
        lines.append(f'DUE:{ical_dt(t["due_date"])}')
    if t.get('done'):
        lines += ['STATUS:COMPLETED', 'PERCENT-COMPLETE:100', f'COMPLETED:{ical_dt(t.get("done_at") or now_iso())}']
    else:
        lines.append('STATUS:NEEDS-ACTION')
    if t.get('priority'):
        lines.append(f'PRIORITY:{[0, 9, 5, 3, 2, 1][min(5, int(t["priority"]))]}')
    lines += ['END:VTODO', 'END:VCALENDAR']
    return '\r\n'.join(lines) + '\r\n'


def unfold(text):
    return re.sub(r'\r?\n[ \t]', '', text)


def ics_to_task(ics, project_id, existing=None):
    body = unfold(ics)
    props = {}
    for line in body.splitlines():
        if ':' not in line or line.startswith(('BEGIN', 'END')):
            continue
        key, _, value = line.partition(':')
        props[key.split(';')[0].upper()] = value
    due = props.get('DUE', '')
    due_iso = ZERO
    if due:
        m = re.match(r'(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})Z?)?', due)
        if m:
            y, mo, d, h, mi, s = m.groups()
            due_iso = f'{y}-{mo}-{d}T{h or "00"}:{mi or "00"}:{s or "00"}Z'
    t = dict(existing or {})
    t.update({
        'title': props.get('SUMMARY', '(untitled)').replace('\\,', ',').replace('\\;', ';'),
        'description': props.get('DESCRIPTION', '').replace('\\n', '\n'),
        'done': props.get('STATUS', '').upper() == 'COMPLETED',
        'due_date': due_iso,
        'project_id': project_id,
        'priority': {9: 1, 5: 2, 3: 3, 2: 4, 1: 5}.get(int(props.get('PRIORITY', '0') or 0), 0),
        '_uid': props.get('UID', ''),
    })
    t['done_at'] = now_iso() if t['done'] else ZERO
    return t


def rest_task(t):
    out = {k: v for k, v in t.items() if not k.startswith('_')}
    out.setdefault('assignees', [])
    out.setdefault('created_by', {'id': 1, 'username': STATE['user'], 'name': 'Omi Tester'})
    out.setdefault('created', now_iso())
    out['updated'] = now_iso()
    return out


class Handler(BaseHTTPRequestHandler):
    protocol_version = 'HTTP/1.1'

    def log_message(self, fmt, *args):  # quiet; the state log is enough
        STATE['log'].append(f'{self.command} {self.path}')

    # ---- helpers -------------------------------------------------------------------------
    def body(self):
        # Read once per request, whatever the handler does with it: on a keep-alive connection an
        # unread body would be parsed as the next request line (a 400 "Bad request syntax").
        if not hasattr(self, '_body'):
            n = int(self.headers.get('Content-Length') or 0)
            self._body = self.rfile.read(n) if n else b''
        return self._body

    def send(self, status, payload=b'', ctype='application/json', extra=None):
        if isinstance(payload, (dict, list)):
            payload = json.dumps(payload).encode()
        elif isinstance(payload, str):
            payload = payload.encode()
        self.send_response(status)
        self.send_header('Content-Type', ctype)
        self.send_header('Content-Length', str(len(payload)))
        # One request per connection: keep-alive is not what this stand-in is for, and a
        # proxied client that pipelines would otherwise trip the stdlib parser.
        self.send_header('Connection', 'close')
        self.close_connection = True
        for k, v in (extra or {}).items():
            self.send_header(k, v)
        self.end_headers()
        if payload:
            self.wfile.write(payload)

    def basic_ok(self):
        auth = self.headers.get('Authorization', '')
        if not auth.startswith('Basic '):
            return False
        try:
            user, _, pw = base64.b64decode(auth[6:]).decode().partition(':')
        except Exception:  # noqa: BLE001
            return False
        return user == STATE['user'] and pw == STATE['password']

    def bearer_ok(self):
        return self.headers.get('Authorization', '') == f'Bearer {STATE["token"]}'

    # ---- dispatch ------------------------------------------------------------------------
    def do_GET(self):
        self.route()

    def do_POST(self):
        self.route()

    def do_PUT(self):
        self.route()

    def do_PATCH(self):
        self.route()

    def do_DELETE(self):
        self.route()

    def do_PROPFIND(self):
        self.route()

    def do_REPORT(self):
        self.route()

    def do_MKCALENDAR(self):
        self.route()

    def do_OPTIONS(self):
        self.send(200, b'', 'text/plain', {'DAV': '1, 3, calendar-access', 'Allow': 'OPTIONS, GET, PUT, DELETE, PROPFIND, REPORT'})

    def route(self):
        self.body()
        path = urlparse(self.path).path
        if path == '/health':
            return self.send(200, 'OK', 'text/plain')
        if path.startswith('/dav'):
            return self.dav(path)
        if path.startswith('/api/v2/'):
            return self.rest(path)
        self.send(404, {'message': 'not found'})

    # ---- REST (what gateway/src/adapters/VikunjaAdapter.js calls) ------------------------
    def rest(self, path):
        if not self.bearer_ok():
            return self.send(401, {'message': 'missing or invalid token'})
        m_tasks = re.fullmatch(r'/api/v2/projects/(\d+)/tasks', path)
        m_task = re.fullmatch(r'/api/v2/tasks/(\d+)', path)
        with LOCK:
            if path == '/api/v2/projects' and self.command == 'GET':
                return self.send(200, {'items': PROJECTS, 'total': len(PROJECTS), 'page': 1, 'per_page': 50, 'total_pages': 1})
            if re.fullmatch(r'/api/v2/projects/\d+/users/search', path):
                return self.send(200, {'items': [], 'total': 0, 'page': 1, 'per_page': 50, 'total_pages': 1})
            if m_tasks and self.command == 'GET':
                pid = int(m_tasks.group(1))
                items = [rest_task(t) for t in TASKS.values() if t['project_id'] == pid]
                return self.send(200, {'items': items, 'total': len(items), 'page': 1, 'per_page': 50, 'total_pages': 1})
            if m_tasks and self.command == 'POST':
                pid = int(m_tasks.group(1))
                data = json.loads(self.body() or b'{}')
                tid = STATE['next_id']
                STATE['next_id'] += 1
                t = {'id': tid, 'title': data.get('title', ''), 'description': data.get('description', ''),
                     'done': False, 'done_at': ZERO, 'due_date': data.get('due_date') or ZERO, 'priority': int(data.get('priority') or 0),
                     'project_id': pid, '_uid': f'{tid}-vikunja@fake', '_name': f'{tid}-vikunja.ics'}
                TASKS[tid] = t
                return self.send(201, rest_task(t))
            if m_task and self.command == 'GET':
                t = TASKS.get(int(m_task.group(1)))
                return self.send(200, rest_task(t)) if t else self.send(404, {'message': 'no task'})
            if m_task and self.command in ('PATCH', 'PUT', 'POST'):
                t = TASKS.get(int(m_task.group(1)))
                if not t:
                    return self.send(404, {'message': 'no task'})
                data = json.loads(self.body() or b'{}')
                for k in ('title', 'description', 'priority', 'due_date', 'done'):
                    if k in data:
                        t[k] = data[k]
                if 'done' in data:
                    t['done_at'] = now_iso() if data['done'] else ZERO
                # A REST edit changes the calendar object too: re-render it from the task.
                t.pop('_ics', None)
                t['_etag'] = (t.get('_etag', 0) or 0) + 1
                return self.send(200, rest_task(t))
            if re.fullmatch(r'/api/v2/tasks/\d+/assignees', path):
                return self.send(201, {})
        self.send(404, {'message': f'unmodelled {self.command} {path}'})

    # ---- CalDAV (what backend/utils/caldav/client.py does against Vikunja) ---------------
    def dav(self, path):
        if not self.basic_ok():
            return self.send(401, 'auth', 'text/plain', {'WWW-Authenticate': 'Basic realm="fake-vikunja"'})
        if self.command == 'MKCALENDAR':
            return self.send(404, 'Vikunja has no MKCALENDAR', 'text/plain')
        m_obj = re.fullmatch(r'/dav/projects/(\d+)/([^/]+\.ics)', path)
        m_cal = re.fullmatch(r'/dav/projects/(\d+)/?', path)
        if self.command == 'PROPFIND':
            if path in ('/dav', '/dav/'):
                return self.multistatus([self.resp('/dav/', '<d:current-user-principal><d:href>/dav/principals/%s/</d:href></d:current-user-principal>' % STATE['user'])])
            if path.startswith('/dav/principals/'):
                return self.multistatus([self.resp(path, '<c:calendar-home-set><d:href>/dav/projects/</d:href></c:calendar-home-set>')])
            if path in ('/dav/projects', '/dav/projects/'):
                rows = [self.resp('/dav/projects/', '<d:resourcetype><d:collection/></d:resourcetype>')]
                for p in PROJECTS:
                    rows.append(self.resp(f'/dav/projects/{p["id"]}/',
                        f'<d:resourcetype><d:collection/><c:calendar/></d:resourcetype><d:displayname>{escape(p["title"])}</d:displayname>'
                        '<c:supported-calendar-component-set><c:comp name="VTODO"/></c:supported-calendar-component-set>'))
                return self.multistatus(rows)
            if m_cal:
                pid = int(m_cal.group(1))
                rows = [self.resp(f'/dav/projects/{pid}/', '<d:resourcetype><d:collection/><c:calendar/></d:resourcetype>'
                                  '<c:supported-calendar-component-set><c:comp name="VTODO"/></c:supported-calendar-component-set>')]
                if self.headers.get('Depth', '0') != '0':
                    with LOCK:
                        for t in TASKS.values():
                            if t['project_id'] == pid:
                                rows.append(self.resp(f'/dav/projects/{pid}/{t["_name"]}', f'<d:getetag>"{t.get("_etag", 1)}"</d:getetag>'))
                return self.multistatus(rows)
            return self.send(404, 'no such collection', 'text/plain')
        if self.command == 'REPORT' and m_cal:
            pid = int(m_cal.group(1))
            want = 'VEVENT' if b'name="VEVENT"' in (self.body() or b'') else 'VTODO'
            rows = []
            if want == 'VTODO':
                with LOCK:
                    for t in TASKS.values():
                        if t['project_id'] == pid:
                            ics = t.get('_ics') or task_to_ics(t)
                            rows.append(self.resp(f'/dav/projects/{pid}/{t["_name"]}',
                                        f'<d:getetag>"{t.get("_etag", 1)}"</d:getetag><c:calendar-data>{escape(ics)}</c:calendar-data>'))
            return self.multistatus(rows)
        if m_obj:
            pid, name = int(m_obj.group(1)), m_obj.group(2)
            with LOCK:
                existing = next((t for t in TASKS.values() if t['_name'] == name and t['project_id'] == pid), None)
                if self.command == 'GET':
                    if not existing:
                        return self.send(404, 'no object', 'text/plain')
                    return self.send(200, existing.get('_ics') or task_to_ics(existing), 'text/calendar', {'ETag': f'"{existing.get("_etag", 1)}"'})
                if self.command == 'PUT':
                    ics = self.body().decode('utf-8', 'replace')
                    if 'BEGIN:VEVENT' in ics and 'BEGIN:VTODO' not in ics:
                        return self.send(403, 'Vikunja stores tasks only', 'text/plain')
                    t = ics_to_task(ics, pid, existing)
                    if existing is None:
                        t['id'] = STATE['next_id']
                        STATE['next_id'] += 1
                        t['_name'] = name
                    t['_ics'] = ics
                    t['_etag'] = (t.get('_etag', 0) or 0) + 1
                    TASKS[t['id']] = t
                    return self.send(201 if existing is None else 204, b'', 'text/plain', {'ETag': f'"{t["_etag"]}"'})
                if self.command == 'DELETE':
                    if existing:
                        del TASKS[existing['id']]
                    return self.send(204 if existing else 404, b'', 'text/plain')
        self.send(404, f'unmodelled {self.command} {path}', 'text/plain')

    def resp(self, href, props):
        return f'<d:response><d:href>{href}</d:href><d:propstat><d:prop>{props}</d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>'

    def multistatus(self, rows):
        xml = '<?xml version="1.0" encoding="utf-8"?><d:multistatus xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">' + ''.join(rows) + '</d:multistatus>'
        self.send(207, xml, 'application/xml; charset=utf-8')


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--port', type=int, default=8901)
    ap.add_argument('--user', default='omi')
    ap.add_argument('--password', default='pw')
    ap.add_argument('--token', default='tok')
    args = ap.parse_args()
    STATE.update(user=args.user, password=args.password, token=args.token)
    srv = ThreadingHTTPServer(('127.0.0.1', args.port), Handler)
    print(f'fake vikunja on http://127.0.0.1:{args.port} (REST token {args.token}; CalDAV {args.user}/{args.password})', flush=True)
    srv.serve_forever()


if __name__ == '__main__':
    main()
