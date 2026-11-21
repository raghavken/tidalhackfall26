"""Replay unchanged PMU packets to the DE1 at 115200 8N1, reading concurrently.

This program checks communication and window identities, never computes energy.
Use reference_detector.py separately for numerical testing.
"""
import argparse
import math
import struct
import sys
import threading
import time
from pathlib import Path
from decode_results import ResultDecoder, write_records

BAUD = 115200


def validate_input(data):
    if not data or len(data) % 28:
        raise ValueError('input must contain complete four-station groups (28 bytes)')
    keys = []
    for offset in range(0, len(data), 7):
        packet = data[offset:offset+7]
        header, sid, index, _ = struct.unpack('<BBHh', packet[:6])
        number = offset // 7
        if header != 0xaa or (sid, index) != (number % 4, number // 4) or sum(packet[:6]) % 256 != packet[6]:
            raise ValueError(f'invalid or unordered input packet at byte {offset}')
        if (index + 1) % 600 == 0:
            keys.append((sid, index))
    return keys


class Receiver(threading.Thread):
    def __init__(self, port, source, echo, raw_path):
        super().__init__(daemon=True)
        self.port, self.source, self.echo, self.raw_path = port, source, echo, raw_path
        self.stop = threading.Event()
        self.decoder = ResultDecoder()
        self.records = []
        self.received = 0
        self.error = None
        self.last_data = time.monotonic()

    def run(self):
        try:
            with self.raw_path.open('wb') as raw:
                while not self.stop.is_set():
                    data = self.port.read(max(1, min(4096, self.port.in_waiting)))
                    if not data:
                        continue
                    raw.write(data)
                    self.last_data = time.monotonic()
                    if self.echo:
                        if data != self.source[self.received:self.received + len(data)]:
                            raise ValueError(f'echo mismatch at or after byte {self.received}')
                        self.received += len(data)
                    else:
                        self.records.extend(self.decoder.feed(data))
                        if self.decoder.discarded:
                            raise ValueError('corrupt bytes in FPGA results')
        except Exception as exc:
            self.error = exc


def send_all(port, data):
    offset = 0
    while offset < len(data):
        written = port.write(data[offset:])
        if not written:
            raise OSError('serial write made no progress')
        offset += written


def run(args):
    import serial  # Only physical replay requires pyserial.
    data = args.input.read_bytes()
    expected_keys = validate_input(data)
    if not math.isfinite(args.speed) or not math.isfinite(args.result_timeout) or args.speed <= 0 or args.result_timeout <= 0:
        raise ValueError('speed and result timeout must be positive')
    raw_path = args.output.with_suffix('.raw.bin')
    if args.output.resolve() == args.input.resolve() or raw_path.resolve() == args.input.resolve():
        raise ValueError('output would overwrite input')
    # A 5% wire-time margin avoids accumulated echo backlog at maximum speed.
    period = max(1 / (30 * args.speed), 28 * 10 / BAUD * 1.05)
    effective = 1 / (30 * period)
    print('Real-time replay (30 groups/s)' if args.speed == 1 else
          f'SIMULATED REPLAY: requested {args.speed:g}x, effective up to {effective:.2f}x')
    print('Set SW0=' + ('1 (echo)' if args.echo else '0 (detector)') + ', press/release KEY0 before starting.')
    reader = None
    try:
        with serial.Serial(args.port, BAUD, bytesize=serial.EIGHTBITS,
                           parity=serial.PARITY_NONE, stopbits=serial.STOPBITS_ONE,
                           timeout=0.05, write_timeout=5, xonxoff=False,
                           rtscts=False, dsrdtr=False) as port:
            port.reset_input_buffer()
            reader = Receiver(port, data, args.echo, raw_path)
            reader.start()
            deadline = time.monotonic()
            for offset in range(0, len(data), 28):
                delay = deadline-time.monotonic()
                if delay > 0:
                    time.sleep(delay)
                if reader.error:
                    raise reader.error
                send_all(port, data[offset:offset+28])
                # Do not burst catch-up groups after a scheduling stall.
                deadline = max(deadline + period, time.monotonic())
            port.flush()
            deadline = time.monotonic() + args.result_timeout
            while time.monotonic() < deadline:
                if reader.error:
                    raise reader.error
                complete = reader.received == len(data) if args.echo else len(reader.records) >= len(expected_keys)
                if complete and time.monotonic() - reader.last_data >= 0.2:
                    break
                time.sleep(0.01)
            reader.stop.set()
            reader.join(timeout=1)
            if reader.is_alive():
                raise RuntimeError('serial reader failed to stop')
            if reader.error:
                raise reader.error
            if args.echo:
                if reader.received != len(data):
                    raise ValueError(f'echo timeout: {reader.received}/{len(data)} bytes')
                print(f'PASS echo: {len(data)} bytes matched input exactly; capture {raw_path}')
            else:
                reader.decoder.finish()
                actual = [(r['station_id'], r['window_end_sample']) for r in reader.records]
                if actual != expected_keys:
                    raise ValueError(f'missing/extra/out-of-order results: {len(actual)}/{len(expected_keys)}; check LEDR[4]')
                print(f'PASS communication: {len(actual)} complete window records; check LEDR[4] remains OFF')
    finally:
        if reader:
            reader.stop.set()
            reader.join(timeout=1)
            write_records(reader.records, args.output)


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--port', required=True, help='COM3 or /dev/cu.usbserial-...')
    p.add_argument('--input', type=Path, required=True)
    p.add_argument('--speed', type=float, default=1, help='1=real time, >1=accelerated simulated replay; bandwidth capped')
    p.add_argument('--echo', action='store_true', help='verify exact echoed bytes; set SW0=1')
    p.add_argument('--output', type=Path, default=Path('results.json'), help='.json or .csv; raw bytes saved alongside')
    p.add_argument('--result-timeout', type=float, default=5, help='seconds to drain replies after transmitting')
    args = p.parse_args()
    try:
        run(args)
    except (ValueError, OSError, RuntimeError, ImportError) as exc:
        p.exit(1, f'FAIL: {exc}\n')


if __name__ == '__main__':
    main()
