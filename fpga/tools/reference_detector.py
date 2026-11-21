"""Test-only exact integer detector. Production replay does not import this."""
import argparse
import csv
import json
import struct
from pathlib import Path
from generate_coefficients import coefficients

NAMES = ('North', 'East', 'South', 'West')
THRESHOLD = 2250000


def read_measurements(path):
    path = Path(path)
    if path.suffix.lower() == '.csv':
        with path.open(newline='') as f:
            for row in csv.DictReader(f):
                yield int(row['station_id']), int(row['sample_index']), int(row['deviation_mhz'])
    else:
        data = path.read_bytes()
        if len(data) % 7:
            raise ValueError('incomplete measurement packet')
        for offset in range(0, len(data), 7):
            packet = data[offset:offset + 7]
            header, sid, index, value = struct.unpack('<BBHh', packet[:6])
            if header != 0xAA or sum(packet[:6]) % 256 != packet[6] or sid > 3:
                raise ValueError(f'invalid measurement packet at {offset}')
            yield sid, index, value


def detect(records, threshold=THRESHOLD):
    table = coefficients()
    sums_i, sums_q, counts = [0]*4, [0]*4, [0]*4
    expected = 0
    for sid, index, value in records:
        if (sid, index) != (expected % 4, expected // 4):
            raise ValueError(f'stream order error: got {sid}/{index}, packet {expected}')
        if not -32768 <= value <= 32767:
            raise ValueError('measurement outside signed 16-bit range')
        expected += 1
        c, s = table[counts[sid] % 120]
        sums_i[sid] += int(value) * c
        sums_q[sid] += int(value) * s
        assert -(1 << 41) <= sums_i[sid] < (1 << 41)
        assert -(1 << 41) <= sums_q[sid] < (1 << 41)
        counts[sid] += 1
        if counts[sid] == 600:
            i, q = sums_i[sid] >> 15, sums_q[sid] >> 15
            energy = i*i + q*q
            assert 0 <= energy < 1 << 55
            yield dict(station_id=sid, station=NAMES[sid], window_end_sample=index,
                       target_frequency_hz=0.25, energy=energy, alarm=energy >= threshold)
            sums_i[sid] = sums_q[sid] = counts[sid] = 0


if __name__ == '__main__':
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('input', type=Path)
    p.add_argument('--threshold', type=int, default=THRESHOLD)
    args = p.parse_args()
    for result in detect(read_measurements(args.input), args.threshold):
        print(json.dumps(result))
