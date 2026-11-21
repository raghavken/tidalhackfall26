"""Decode FPGA 14-byte result packets into JSON or CSV records."""
import argparse
import csv
import json
import struct
import sys
from pathlib import Path

NAMES = ('North', 'East', 'South', 'West')
FIELDS = ('station_id', 'station', 'window_end_sample', 'target_frequency_hz', 'energy', 'alarm')


def decode_packet(packet):
    if len(packet) != 14:
        raise ValueError('result packet must contain 14 bytes')
    header, sid, index, energy, alarm, checksum = struct.unpack('<BBHQBB', packet)
    if header != 0x55 or sid > 3 or alarm > 1 or energy >= 1 << 55:
        raise ValueError('invalid result fields')
    if sum(packet[:13]) % 256 != checksum:
        raise ValueError('result checksum mismatch')
    return dict(station_id=sid, station=NAMES[sid], window_end_sample=index,
                target_frequency_hz=0.25, energy=energy, alarm=bool(alarm))


class ResultDecoder:
    """Incremental framing; preserves partial packets across serial reads.

    On corruption, scan bytewise for another header and count every discarded
    byte. Consumers must treat nonzero discarded as a failed replay.
    """
    def __init__(self):
        self.buffer = bytearray()
        self.discarded = 0

    def feed(self, data):
        self.buffer.extend(data)
        records = []
        while self.buffer:
            if self.buffer[0] != 0x55:
                del self.buffer[0]
                self.discarded += 1
                continue
            if len(self.buffer) < 14:
                break
            try:
                record = decode_packet(self.buffer[:14])
            except ValueError:
                del self.buffer[0]
                self.discarded += 1
            else:
                records.append(record)
                del self.buffer[:14]
        return records

    def finish(self):
        if self.discarded or self.buffer:
            raise ValueError(f'corrupt/truncated results: {self.discarded} discarded bytes, {len(self.buffer)} trailing bytes')


def write_records(records, output):
    output = Path(output)
    with output.open('w', newline='') as f:
        if output.suffix.lower() == '.csv':
            writer = csv.DictWriter(f, fieldnames=FIELDS)
            writer.writeheader()
            writer.writerows(records)
        else:
            json.dump(records, f, indent=2)
            f.write('\n')


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('input', type=Path, help='raw result bytes (or --hex Icarus capture)')
    p.add_argument('--hex', action='store_true', help='input contains whitespace-separated hex bytes')
    p.add_argument('--output', type=Path, help='.json or .csv; default JSON lines on stdout')
    args = p.parse_args()
    data = bytes.fromhex(args.input.read_text()) if args.hex else args.input.read_bytes()
    decoder = ResultDecoder()
    records = decoder.feed(data)
    decoder.finish()
    if args.output:
        write_records(records, args.output)
    else:
        for record in records:
            print(json.dumps(record))
    print(f'PASS decoded {len(records)} result packets', file=sys.stderr)


if __name__ == '__main__':
    try:
        main()
    except (ValueError, OSError) as exc:
        sys.exit(f'FAIL: {exc}')
