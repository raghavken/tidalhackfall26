"""Convert unchanged simulator files and numerical edge cases to RTL vectors."""
import argparse
import csv
import math
import random
import struct
from pathlib import Path
from reference_detector import detect, read_measurements

ROOT = Path(__file__).resolve().parents[2]


def write_suite(out, name, records, raw=None, expected=None):
    records = list(records)
    results = list(detect(records)) if expected is None else expected
    (out / f'{name}.samples.hex').write_text(''.join(
        f'{(s << 32) | (n << 16) | (x & 65535):09x}\n' for s, n, x in records))
    (out / f'{name}.expected.hex').write_text(''.join(
        f"{(r['station_id'] << 72) | (r['window_end_sample'] << 56) | (r['energy'] << 1) | int(r['alarm']):019x}\n"
        for r in results))
    if raw is None:
        packets = []
        for sid, n, x in records:
            body = struct.pack('<BBHh', 0xaa, sid, n, x)
            packets.append(body + bytes([sum(body) % 256]))
        raw = b''.join(packets)
    (out / f'{name}.hex').write_text(''.join(f'{b:02x}\n' for b in raw))
    print(f'PASS vectors {name}: {len(records)} samples, {len(results)} results')
    return results


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--output', type=Path, default=ROOT/'fpga/build')
    args = p.parse_args()
    out = args.output
    out.mkdir(parents=True, exist_ok=True)
    for name, alarm in [('normal', [False]*4), ('grid_oscillation', [True]*4), ('isolated', [True, False, False, False])]:
        path = ROOT/'simulator/data'/f'{name}.bin'
        records = list(read_measurements(path))
        if len(records) != 8400:
            raise ValueError(f'{path}: expected default 8400 records')
        with path.with_suffix('.csv').open(newline='') as f:
            rows = list(csv.DictReader(f))
        assert records == [(int(r['station_id']), int(r['sample_index']), int(r['deviation_mhz'])) for r in rows]
        results = write_suite(out, name, records, path.read_bytes())
        assert len(results) == 12
        post = [r for r in results if r['window_end_sample'] == 1799]
        assert [r['alarm'] for r in post] == alarm
        print(f"PASS {name} post-disturbance energies: {[r['energy'] for r in post]}")
    # Exact prefixes avoid readmemh truncation warnings in the UART test.
    (out/'uart.hex').write_text('\n'.join((out/'grid_oscillation.hex').read_text().splitlines()[:16800])+'\n')
    (out/'uart.expected.hex').write_text('\n'.join((out/'grid_oscillation.expected.hex').read_text().splitlines()[:4])+'\n')
    rng = random.Random(42)
    # Different signals on each station in each window also check independence.
    kinds = ['zero', 'constant', 'tone', 'noise', 'opposite', 'off_frequency', 'large', 'impulse']
    records = []
    for index in range(8*600+37):
        for sid in range(4):
            kind = kinds[(index//600+sid) % len(kinds)]
            n = index % 600
            tone = round(20*math.sin(2*math.pi*n/120))
            values = dict(zero=0, constant=32767, tone=tone,
                          noise=tone+rng.randint(-2, 2), opposite=-tone,
                          off_frequency=round(20*math.sin(2*math.pi*n/30)),
                          large=32767 if math.cos(2*math.pi*n/120)>=0 else -32768,
                          impulse=-32768 if n==599 else 0)
            records.append((sid, index, values[kind]))
    results = write_suite(out, 'numerical', records)
    for r in results:
        kind = kinds[(r['window_end_sample']//600+r['station_id']) % len(kinds)]
        if kind in ('zero', 'constant', 'off_frequency'):
            assert r['energy'] <= 32, (kind, r)
        elif kind != 'impulse':
            assert r['alarm'], (kind, r)
    tone_energies = [r['energy'] for r in results if kinds[(r['window_end_sample']//600+r['station_id']) % len(kinds)] == 'tone']
    opposite_energies = [r['energy'] for r in results if kinds[(r['window_end_sample']//600+r['station_id']) % len(kinds)] == 'opposite']
    assert max(tone_energies+opposite_energies) / min(tone_energies+opposite_energies) < 1.001
    # First validate one station alone, then the shared four-station datapath.
    single_records = [r for r in records if r[0] == 0]
    single_results = [r for r in results if r['station_id'] == 0]
    write_suite(out, 'single', single_records, expected=single_results)


if __name__ == '__main__':
    main()
