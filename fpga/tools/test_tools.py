"""Protocol, serial concurrency, malformed-input, and RTL-capture checks."""
import contextlib
import io
import json
import queue
import struct
import sys
import tempfile
import types
import unittest
from pathlib import Path
from unittest.mock import patch
from decode_results import ResultDecoder, decode_packet, write_records
from reference_detector import detect, read_measurements
from replay import run, validate_input

ROOT = Path(__file__).resolve().parents[2]
BUILD = ROOT / 'fpga/build'


def result_packet(sid=2, index=599, energy=35800000, alarm=True):
    body = struct.pack('<BBHQB', 0x55, sid, index, energy, alarm)
    return body + bytes([sum(body) % 256])


class FakeSerial:
    """Duplex serial peer with deliberately short writes and fragmented reads."""
    echo = False
    drop = False

    def __init__(self, *args, **kwargs):
        self.rx = queue.Queue()
        self.pending = bytearray()

    def __enter__(self):
        return self

    def __exit__(self, *args):
        return False

    @property
    def in_waiting(self):
        return self.rx.qsize()

    def reset_input_buffer(self):
        pass

    def flush(self):
        pass

    def write(self, data):
        chunk = data[:5]
        if self.echo:
            response = chunk
        else:
            response = b''
            self.pending.extend(chunk)
            while len(self.pending) >= 7:
                packet = bytes(self.pending[:7])
                del self.pending[:7]
                sid, index = packet[1], int.from_bytes(packet[2:4], 'little')
                if index == 599 and not self.drop:
                    response += result_packet(sid=sid)
        for byte in response:
            self.rx.put(byte)
        return len(chunk)

    def read(self, size):
        try:
            return bytes([self.rx.get(timeout=0.02)])
        except queue.Empty:
            return b''


class ToolsTests(unittest.TestCase):
    def test_decoder_fragmentation_payload_header_and_corruption(self):
        packet = result_packet(energy=0x55aa55)
        decoder = ResultDecoder()
        records = []
        for b in packet*4:
            records.extend(decoder.feed(bytes([b])))
        decoder.finish()
        self.assertEqual(len(records), 4)
        self.assertEqual(records[0]['energy'], 0x55aa55)
        broken = bytearray(packet)
        broken[-1] ^= 1
        decoder = ResultDecoder()
        self.assertEqual(len(decoder.feed(bytes(broken)+packet)), 1)
        with self.assertRaises(ValueError):
            decoder.finish()
        decoder = ResultDecoder()
        decoder.feed(packet[:5])
        with self.assertRaises(ValueError):
            decoder.finish()
        for kwargs in (dict(sid=4), dict(energy=1 << 55), dict(alarm=2)):
            with self.assertRaises(ValueError):
                decode_packet(result_packet(**kwargs))

    def test_input_checks(self):
        data = (ROOT/'simulator/data/normal.bin').read_bytes()
        self.assertEqual(len(validate_input(data)), 12)
        for broken in (b'', data[:-1], data[28:], data[:28]*2, bytes([0])+data[1:]):
            with self.assertRaises(ValueError):
                validate_input(broken)

    def test_reference_order_and_csv(self):
        for name in ('normal', 'grid_oscillation', 'isolated'):
            base = ROOT/'simulator/data'/name
            self.assertEqual(list(detect(read_measurements(base.with_suffix('.bin')))),
                             list(detect(read_measurements(base.with_suffix('.csv')))))
        with self.assertRaises(ValueError):
            list(detect([(1, 0, 0)]))

    def test_replay_concurrent_echo_and_detector(self):
        serial = types.SimpleNamespace(Serial=FakeSerial, EIGHTBITS=8, PARITY_NONE='N', STOPBITS_ONE=1)
        with tempfile.TemporaryDirectory(dir=BUILD) as tmp:
            path = Path(tmp)
            for echo in (True, False):
                FakeSerial.echo, FakeSerial.drop = echo, False
                data = (ROOT/'simulator/data/normal.bin').read_bytes()[:28*(4 if echo else 600)]
                source = path/'input.bin'
                source.write_bytes(data)
                output = path/'results.json'
                args = types.SimpleNamespace(input=source, output=output, speed=100000,
                                             result_timeout=1, port='FAKE', echo=echo)
                with patch.dict(sys.modules, {'serial': serial}), contextlib.redirect_stdout(io.StringIO()):
                    run(args)
                self.assertEqual(source.read_bytes(), data)
                records = json.loads(output.read_text())
                if echo:
                    self.assertEqual(output.with_suffix('.raw.bin').read_bytes(), data)
                else:
                    self.assertEqual([r['station_id'] for r in records], [0, 1, 2, 3])
            FakeSerial.drop = True
            args.result_timeout = 0.05
            with patch.dict(sys.modules, {'serial': serial}), contextlib.redirect_stdout(io.StringIO()):
                with self.assertRaises(ValueError):
                    run(args)
            args.output = args.input
            with patch.dict(sys.modules, {'serial': serial}):
                with self.assertRaises(ValueError):
                    run(args)

    def test_rtl_output_captures(self):
        for name in ('normal', 'grid_oscillation', 'isolated', 'uart'):
            with self.subTest(name=name):
                capture = BUILD/f'{name}.results.hex'
                self.assertTrue(capture.exists(), f'run make test-integration first: {capture}')
                decoder = ResultDecoder()
                results = decoder.feed(bytes.fromhex(capture.read_text()))
                decoder.finish()
                dataset = 'grid_oscillation' if name == 'uart' else name
                expected = list(detect(read_measurements(ROOT/'simulator/data'/f'{dataset}.bin')))
                self.assertEqual(results, expected[:4] if name == 'uart' else expected)
                output = BUILD/f'{name}.results.json'
                write_records(results, output)
                write_records(results, output.with_suffix('.csv'))


if __name__ == '__main__':
    suite = unittest.defaultTestLoader.loadTestsFromTestCase(ToolsTests)
    result = unittest.TextTestRunner(verbosity=2).run(suite)
    print('PASS Python tools' if result.wasSuccessful() else 'FAIL Python tools')
    sys.exit(not result.wasSuccessful())
