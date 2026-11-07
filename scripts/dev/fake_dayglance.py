#!/usr/bin/env python3
"""A stand-in dayGLANCE MCP for gateway and Omi tests without the desktop app: the
Streamable-HTTP MCP the gateway's DayglanceMcpClient speaks (bearer token, initialize,
tools/list, tools/call), with the tools it reads and writes, in memory.

    python3 scripts/dev/fake_dayglance.py --port 8902 --token dg-tok

Then run the gateway with ENABLE_DAYGLANCE=true DAYGLANCE_MCP_HOST=127.0.0.1
DAYGLANCE_MCP_PORT=8902 DAYGLANCE_MCP_TOKEN=dg-tok. What is modelled: dayglance_ping,
dayglance_get_today / dayglance_get_day ({blocks, frames}), dayglance_list_unscheduled_tasks
({items}), dayglance_list_users ({users}), dayglance_create_task (a block when `start` is
given, an inbox item otherwise; assignee_id must be a listed user), dayglance_set_task_completion. Only what the gateway uses.
"""

import argparse
import json
import threading
from datetime import date, datetime
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

STATE = {'next_id': 1, 'token': 'dg-tok', 'blocks': [], 'inbox': [], 'log': []}
USERS = [{'id': 'u-sam', 'name': 'Sam'}, {'id': 'u-dana', 'name': 'Dana'}]
LOCK = threading.Lock()

TOOLS = [
    {'name': 'dayglance_ping', 'description': 'Connectivity check.', 'inputSchema': {'type': 'object', 'properties': {}}},
    {'name': 'dayglance_get_today', 'description': "Today's schedule.", 'inputSchema': {'type': 'object', 'properties': {}}},
    {'name': 'dayglance_get_day', 'description': "One day's schedule.", 'inputSchema': {'type': 'object', 'properties': {'date': {'type': 'string'}}}},
    {'name': 'dayglance_list_unscheduled_tasks', 'description': 'The inbox.', 'inputSchema': {'type': 'object', 'properties': {}}},
    {'name': 'dayglance_list_users', 'description': 'Household members.', 'inputSchema': {'type': 'object', 'properties': {}}},
    {'name': 'dayglance_create_task', 'description': 'Create a task or a scheduled block.', 'inputSchema': {'type': 'object', 'properties': {'title': {'type': 'string'}, 'start': {'type': 'string'}, 'duration_minutes': {'type': 'integer'}, 'notes': {'type': 'string'}, 'deadline': {'type': 'string'}, 'priority': {'type': 'integer'}}}},
    {'name': 'dayglance_set_task_completion', 'description': 'Tick a task.', 'inputSchema': {'type': 'object', 'properties': {'task_id': {'type': 'string'}, 'completed': {'type': 'boolean'}}}},
]


def _new_id():
    STATE['next_id'] += 1
    return f'dg{STATE["next_id"] - 1}'


def create_task(args):
    title = str(args.get('title') or '').strip()
    if not title:
        raise ValueError('title is required')
    start = str(args.get('start') or '').strip()
    assignee = args.get('assignee_id')
    if assignee is not None and not any(u['id'] == assignee for u in USERS):
        raise ValueError(f'No active user with id {json.dumps(assignee)}. Enumerate valid assignees with dayglance_list_users')
    with LOCK:
        if start:
            if 'priority' in args or 'deadline' in args:
                raise ValueError('a scheduled task takes no priority or deadline')  # dayGLANCE rejects these
            day, _, clock = start.partition(' ')
            datetime.strptime(day, '%Y-%m-%d')
            block = {
                'id': _new_id(), 'type': 'task', 'title': title, 'date': day,
                'start_time': clock or '00:00', 'duration': int(args.get('duration_minutes') or 30),
                'all_day': not clock, 'completed': False, 'notes': args.get('notes') or '',
                **({'assignedUserSyncIds': [assignee]} if assignee else {}),
            }
            STATE['blocks'].append(block)
            return {'task': block}
        item = {'id': _new_id(), 'title': title, 'completed': False, 'priority': int(args.get('priority') or 0),
                'deadline': args.get('deadline') or None, 'notes': args.get('notes') or '',
                **({'assignedUserSyncIds': [assignee]} if assignee else {})}
        STATE['inbox'].append(item)
        return {'task': item}


def set_completion(args):
    with LOCK:
        for row in STATE['blocks'] + STATE['inbox']:
            if row['id'] == str(args.get('task_id')):
                row['completed'] = bool(args.get('completed'))
                return {'block': row}
    raise ValueError('no such task')


def call(name, args):
    if name == 'dayglance_ping':
        return {'ok': True}
    if name in ('dayglance_get_today', 'dayglance_get_day'):
        day = args.get('date') or date.today().isoformat()
        with LOCK:
            return {'date': day, 'blocks': [b for b in STATE['blocks'] if b['date'] == day], 'frames': []}
    if name == 'dayglance_list_unscheduled_tasks':
        with LOCK:
            return {'items': list(STATE['inbox']), 'next_cursor': None}
    if name == 'dayglance_list_users':
        return {'users': USERS}
    if name == 'dayglance_create_task':
        return create_task(args)
    if name == 'dayglance_set_task_completion':
        return set_completion(args)
    raise ValueError(f'unknown tool {name}')


class Handler(BaseHTTPRequestHandler):
    protocol_version = 'HTTP/1.1'

    def log_message(self, fmt, *args):  # quiet
        STATE['log'].append(fmt % args)

    def _json(self, status, payload):
        body = json.dumps(payload).encode()
        self.send_response(status)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(body)))
        self.send_header('Connection', 'close')
        self.end_headers()
        self.wfile.write(body)
        self.close_connection = True

    def do_GET(self):  # noqa: N802
        if self.path == '/_state':  # for tests: what the fake holds
            with LOCK:
                return self._json(200, {'blocks': STATE['blocks'], 'inbox': STATE['inbox']})
        self._json(404, {'error': 'not found'})

    def do_POST(self):  # noqa: N802
        length = int(self.headers.get('Content-Length') or 0)
        raw = self.rfile.read(length) if length else b''
        if self.path != '/mcp':
            return self._json(404, {'error': 'not found'})
        if self.headers.get('Authorization') != f'Bearer {STATE["token"]}':
            return self._json(401, {'error': 'bad token'})
        try:
            msg = json.loads(raw or b'{}')
        except json.JSONDecodeError:
            return self._json(400, {'error': 'bad json'})
        method, rid, params = msg.get('method'), msg.get('id'), msg.get('params') or {}
        if method == 'notifications/initialized':
            self.send_response(202)
            self.send_header('Content-Length', '0')
            self.send_header('Connection', 'close')
            self.end_headers()
            self.close_connection = True
            return None
        if method == 'initialize':
            result = {'protocolVersion': '2024-11-05', 'capabilities': {'tools': {}}, 'serverInfo': {'name': 'fake-dayglance', 'version': '0'}, 'sessionId': 'fake-session'}
        elif method == 'tools/list':
            result = {'tools': TOOLS}
        elif method == 'tools/call':
            try:
                out = call(params.get('name'), params.get('arguments') or {})
                result = {'content': [{'type': 'text', 'text': json.dumps(out)}], 'structuredContent': out}
            except ValueError as error:
                result = {'content': [{'type': 'text', 'text': json.dumps({'error': {'message': str(error)}})}], 'isError': True}
        else:
            return self._json(200, {'jsonrpc': '2.0', 'id': rid, 'error': {'code': -32601, 'message': f'unknown method {method}'}})
        return self._json(200, {'jsonrpc': '2.0', 'id': rid, 'result': result})


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('--port', type=int, default=8902)
    parser.add_argument('--host', default='127.0.0.1')
    parser.add_argument('--token', default='dg-tok')
    args = parser.parse_args()
    STATE['token'] = args.token
    server = ThreadingHTTPServer((args.host, args.port), Handler)
    print(f'fake dayGLANCE MCP on http://{args.host}:{args.port}/mcp (token {args.token})', flush=True)
    server.serve_forever()


if __name__ == '__main__':
    main()
