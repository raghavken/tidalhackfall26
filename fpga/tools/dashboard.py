"""Serve the local USB-Blaster replay dashboard."""
import argparse
import json
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
import struct
import subprocess
from tempfile import TemporaryDirectory
from time import monotonic, sleep
from threading import Lock, Thread

from decode_results import decode_packet, NAMES
from reference_detector import detect, read_measurements

TOOLS = Path(__file__).resolve().parent
ROOT = TOOLS.parents[1]
SCENARIOS = {'normal', 'grid_oscillation', 'isolated'}
lock = Lock()
run = {'state': 'idle', 'sent': 0, 'total': 0, 'results': []}


def windows_path(path):
    return subprocess.check_output(['wslpath', '-w', str(path)], text=True).strip()


def hardware_events(quartus_stp, source):
    with TemporaryDirectory(prefix='de1-replay-') as directory:
        events = Path(directory) / 'events.log'
        events.touch()
        diagnostics = Path(directory) / 'quartus.log'
        command = [quartus_stp, '-t', windows_path(TOOLS / 'jtag_replay.tcl'),
                   windows_path(source), windows_path(events)]
        with diagnostics.open('wb') as output, events.open() as log:
            with subprocess.Popen(command, stdin=subprocess.DEVNULL, stdout=output,
                                  stderr=subprocess.STDOUT) as process:
                try:
                    last_event = monotonic()
                    while True:
                        offset = log.tell()
                        line = log.readline()
                        if line.endswith('\n'):
                            last_event = monotonic()
                            yield line.strip()
                        else:
                            log.seek(offset)
                            if process.poll() is not None:
                                if process.returncode:
                                    detail = diagnostics.read_text(errors='replace').splitlines()
                                    raise RuntimeError(' / '.join(detail[-20:]) or 'Quartus failed')
                                break
                            if monotonic() - last_event > 45:
                                raise RuntimeError('No FPGA replay progress for 45 seconds')
                            sleep(0.1)
                finally:
                    if process.poll() is None:
                        process.kill()


def replay(scenario, quartus_stp):
    try:
        source = ROOT / 'simulator' / 'data' / (scenario + '.bin')
        expected = list(detect(read_measurements(source)))
        complete = None
        for line in hardware_events(quartus_stp, source):
            kind, _, payload = line.partition(' ')
            if kind == 'SENT':
                count, raw = payload.split()
                _, station, index, deviation = struct.unpack('<BBHh', bytes.fromhex(raw)[:6])
                with lock:
                    run.update(sent=int(count), sample={
                        'hex': raw, 'station': NAMES[station], 'index': index,
                        'deviation': deviation})
            elif kind == 'RECEIVED':
                raw = decode_packet(bytes.fromhex(payload))
                with lock:
                    index = len(run['results'])
                    match = index < len(expected) and raw == expected[index]
                    run['results'].append(dict(raw, hex=payload, verified=match,
                                               energy=str(raw['energy'])))
            elif kind == 'COMPLETE':
                complete = int(payload)
            elif kind == 'ERROR':
                raise RuntimeError(payload)
        with lock:
            if (complete != run['total'] or len(run['results']) != len(expected)
                    or not all(row['verified'] for row in run['results'])):
                raise ValueError('Hardware results or packet counts differ from the Python reference')
            run.update(state='verified', sent=complete)
    except (OSError, ValueError, RuntimeError, subprocess.SubprocessError) as exc:
        with lock:
            run.update(state='failed', error=str(exc))


class Dashboard(BaseHTTPRequestHandler):
    def reply(self, status, content_type, body):
        self.send_response(status)
        self.send_header('Content-Type', content_type)
        self.send_header('Content-Length', str(len(body)))
        self.send_header('Cache-Control', 'no-store')
        self.end_headers()
        self.wfile.write(body)

    def json_reply(self, status, value):
        self.reply(status, 'application/json', json.dumps(value).encode())

    def do_GET(self):
        if self.path == '/':
            self.reply(200, 'text/html; charset=utf-8', (TOOLS / 'dashboard.html').read_bytes())
        elif self.path == '/api/run':
            with lock:
                snapshot = dict(run, results=list(run['results']))
            self.json_reply(200, snapshot)
        else:
            self.send_error(404)

    def do_POST(self):
        if self.path != '/api/run':
            self.send_error(404)
            return
        if self.headers.get_content_type() != 'application/json':
            self.send_error(415)
            return
        try:
            length = int(self.headers.get('Content-Length', '0'))
            if not 0 < length <= 256:
                raise ValueError
            scenario = json.loads(self.rfile.read(length))['scenario']
            if not isinstance(scenario, str) or scenario not in SCENARIOS:
                raise ValueError
        except (ValueError, TypeError, KeyError):
            self.json_reply(400, {'error': 'Invalid scenario'})
            return
        with lock:
            busy = run['state'] == 'running'
            if not busy:
                source = ROOT / 'simulator' / 'data' / (scenario + '.bin')
                run.clear()
                run.update(state='running', scenario=scenario, sent=0,
                           total=source.stat().st_size // 7, results=[])
        if busy:
            self.json_reply(409, {'error': 'A replay is already running'})
            return
        Thread(target=replay, args=(scenario, self.server.quartus_stp), daemon=True).start()
        self.json_reply(202, {'state': 'running'})


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--port', type=int, default=8765)
    parser.add_argument('--quartus-stp', default='/mnt/c/altera/13.0sp1/quartus/bin64/quartus_stp.exe')
    args = parser.parse_args()
    with ThreadingHTTPServer(('127.0.0.1', args.port), Dashboard) as server:
        server.quartus_stp = args.quartus_stp
        print(f'Dashboard at http://localhost:{args.port}', flush=True)
        server.serve_forever()


if __name__ == '__main__':
    main()
