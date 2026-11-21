# Oscillation Cartographer FPGA MVP

Verilog-2001 implementation for the **original Terasic DE1, Cyclone II**.
All project files and generated outputs stay under `fpga/`. The existing
simulator and its seven-byte protocol are unchanged.

## Verification status

Verified with Icarus Verilog/vvp on Apple Silicon macOS:

- UART RX/TX, parser, station routing, UART echo and reset/error handling.
- Single-station and four-station integer correlation, including signed limits,
  600th-sample contribution, partial windows, DC, noise, opposite phase and 1 Hz.
- Every completed window in each original 8,400-packet dataset: exact integer
  energy and alarm equality, followed through the serialized result packets.
- A separate UART-input integration run: 2,400 measurements / four results.
- FIFO stalls, four closely spaced results, pointer wrap, zero extension and
  explicit overflow handling. Python result decoder and concurrent replay
  against a simulated serial peer with fragmented reads and short writes.
- Existing simulator suite: 18 tests passed, run without changing its files.

**Not performed:** Quartus synthesis, fitting, resource utilization review,
TimeQuest timing closure, programming, physical echo or physical detection.
Verilator is optional and was not available. The Windows deployment below is
a procedure to execute, not a completed hardware verification report.

## Run tests on macOS

From the repository root:

```bash
brew install icarus-verilog
cd fpga
python3 -m venv .venv
.venv/bin/python -m pip install -r requirements.txt
make test
make test-uart
make test-parser
make test-detector
make test-integration
```

`make test` runs all self-checking benches plus Python checks. Each failure
returns a nonzero exit code; successful stages print `PASS`. No GTKWave or
Quartus installation is needed. The numerical reference and vector tools use
only Python's standard library. `make PYTHON=python3 test` also works without a
venv. `pyserial` is required for physical replay. NumPy/pytest are included for
working alongside the simulator. Its CLI plot tests also require matplotlib.

Additional targets: `test-echo`, `test-formatter`, `test-faults`, `test-tools`,
`vectors`, `clean`. Generated hex files, executable simulations, decoded
captures and waveforms belong in the ignored `build/` directory.

`make test-detector` first exercises station 0 alone, then the shared datapath
with all four stations, including consecutive-clock inputs. `make
test-integration` injects decoded UART bytes at the parser for all 58,800 bytes
of each dataset; it still checks output using an independently instantiated
UART receiver. It then exercises the serial input itself on a smaller dataset
prefix. UART benches use 16 clocks/bit to reduce run time; production uses
434 clocks/bit (50 MHz / 115200, rounded).

## Simulator contract checked before implementation

Inspected `simulator/packet_encoder.py`, `tests/test_generator.py`, scenario
constants and actual CSV/binary datasets. Each file has 8,400 packets / 58,800
bytes, in sample-major then North/East/South/West order. All binary values agree
with the CSV deviations. `AA 02 64 00 F0 FF FF` decodes as station 2, index 100,
−16 mHz. Header, signed two's complement, little-endian fields and modulo-256
checksum match the requested contract. The generic Python encoder allows IDs
0–255; this FPGA correctly rejects IDs outside 0–3.

Measurement packet (7 bytes):

| Offset | Field |
|---|---|
| 0 | `AA` |
| 1 | Station 0–3 |
| 2–3 | Sample index, unsigned 16-bit little-endian |
| 4–5 | Deviation in mHz, signed 16-bit little-endian |
| 6 | Sum of bytes 0–5 modulo 256 |

Result packet (14 bytes):

| Offset | Field |
|---|---|
| 0 | `55` |
| 1 | Station 0–3 |
| 2–3 | Window end sample index, unsigned little-endian |
| 4–11 | Energy, unsigned 64-bit little-endian (upper nine bits zero) |
| 12 | Alarm, exactly 0 or 1 |
| 13 | Sum of bytes 0–12 modulo 256 |

There is no end-of-stream or error packet in this MVP. Check LEDR[4] during
hardware runs. Host tools detect missing/extra result packets and malformed
output. A missing sample is detected when the next received station/index
violates the expected order. A silent loss at the very end of an incomplete
window cannot be distinguished from a stopped replay by the FPGA protocol.

## RTL design

`top.v` connects UART RX → packet parser → station demux → correlator → result
FIFO/formatter → UART TX. Echo mode uses the same parser and output FIFO.

- RX has a two-flop synchronizer, midpoint start validation, eight LSB-first
  data samples, stop validation and a one-cycle valid/error pulse. Invalid stop
  bits require a return to idle high before accepting another start bit.
- The parser consumes exactly seven bytes after a header. Payload `AA` bytes
  do not restart framing. It rejects invalid station IDs/checksums. An
  incomplete packet times out after 20 ms without a byte. A UART framing error
  aborts parser state through its reset input; top latches the error.
- `station_demux.v` starts at station 0 / index 0 and enforces the documented
  order. Each station retains its latest sample, accepted count and index.
  The index tracker is 17 bits so a 16-bit input wrap cannot silently restart.
- `correlator.v` keeps separate I/Q accumulators, phase, window count, energy,
  window end and published alarm state per station. The arithmetic datapath is
  shared across stations: two 16×16 signed multipliers, sign-extended 42-bit
  accumulation, and a window-completion stage with two 27×27 signed squares.
  It accepts one sample per clock and advances only on `sample_valid`.
- ROM constants are generated offline with Python `round(32767*cos(...))` and
  `round(32767*sin(...))` over 120 entries. No real arithmetic is synthesized.
  Regenerate with `python tools/generate_coefficients.py`; `--check` detects
  stale constants. Tiny coefficient rounding asymmetry gives energy 16 for a
  constant +32767 mHz input, negligible against the threshold.
- The completed I/Q sums include sample 600 before clearing. Bits `[41:15]`
  implement arithmetic shift right by 15 with signed 27-bit outputs. Signed
  54-bit squares are zero-extended before their unsigned 55-bit sum. Even a
  conservative bound `600*32768*32767` fits the signed 42-bit accumulators.
- Windows are non-overlapping: end indices 599, 1199, 1799, etc. The last
  300 samples of a default dataset do not publish a result.
- The output FIFO holds eight pending packets plus the active packet. Its
  ready/valid byte interface stalls safely while UART TX is busy. Overflow
  latches a fatal stream error rather than silently accepting lost results.
  This depth covers four station completions even in the fast parser tests.

Packet, UART, timeout, ordering and queue errors latch until KEY0 reset. They
invalidate published alarms and window-valid LEDs and flush pending packets.
A byte already accepted by the UART transmitter may finish; an incomplete
output packet may therefore remain in a failed capture. Discard the failed
run, reset and restart from sample zero. All counters and detector state clear
on reset. Header-search garbage is ignored until `AA`; framing/checksum errors
and subsequent ordering checks provide error detection, not correction.

## Dataset measurements

Threshold remains **2,250,000** (`top.ENERGY_THRESHOLD` and
`correlator.ENERGY_THRESHOLD`), equivalent to approximately 5 mHz sinusoidal
amplitude for 600 samples. No threshold adjustment was needed.

Energies for the fully post-disturbance window **samples 1200–1799**:

| Dataset | North | East | South | West | Alarms N/E/S/W |
|---|---:|---:|---:|---:|---|
| normal | 170 | 377 | 778 | 68 | OFF/OFF/OFF/OFF |
| grid_oscillation | 36,180,241 | 12,972,698 | 26,255,412 | 4,419,405 | ON/ON/ON/ON |
| isolated | 56,355,130 | 377 | 778 | 68 | ON/OFF/OFF/OFF |

Each full file produces exactly 12 results. First-window results include onset
and are not expected to have the same alarm pattern as settled windows. The
reference uses Python integers and the exact ROM coefficients; the FPGA tests
require exact equality for every energy, index, station and alarm, not tolerance.

From the repository root:

```bash
python fpga/tools/reference_detector.py simulator/data/grid_oscillation.bin
python fpga/tools/reference_detector.py simulator/data/grid_oscillation.csv
python fpga/tools/decode_results.py fpga/build/grid_oscillation.results.hex --hex \
  --output fpga/build/grid_oscillation.json
```

`decode_results.py` also reads raw serial captures, supports CSV output and
validates header, station, 55-bit zero extension, alarm and checksum. It buffers
partial serial reads. On corrupt bytes it can resynchronize, but reports a
failed replay rather than silently treating recovered data as a clean run.

## Board assignments and controls

The assignments were checked against the original **DE1 User Manual**:
[manufacturer download](https://www.terasic.com.tw/attachment/archive/83/DE1_UserManual_v1018.pdf)
and [accessible mirror of the Altera-authored manual](https://dl.btc.pl/kamami_wa/terasic_de1_de1_usermanual_v1018.pdf),
tables 4.1–4.3 (printed pp. 28–29), 4.5 (p. 32) and 4.10 (p. 39).
The manual identifies the Cyclone II 2C20 / 484-pin family/package. The requested
**EP2C20F484C7** is selected in `quartus/de1.qsf`; no pre-existing working
Quartus project or physical board was available to cross-check its speed grade.
Check the actual chip marking before programming. These are not DE1-SoC pins.

| Top port | Board resource | FPGA pin |
|---|---|---|
| CLOCK_50 | 50 MHz oscillator | L1 |
| RESET_N | KEY0, active-low reset | R22 |
| MODE | SW0: 1 echo, 0 detector | L22 |
| UART_RXD / UART_TXD | MAX232 RS-232 interface | F14 / G12 |
| LEDR[0:3] | North/East/South/West alarms | R20/R19/U19/Y19 |
| LEDR[4] | Latched packet/stream/queue error | T18 |
| LEDR[5] | At least one published window, valid | V19 |
| LEDG[0] / [1] | RX packet / TX activity, stretched 100 ms | U22/U21 |
| LEDG[7] | 1 Hz heartbeat | Y21 |

LEDG[2:6] are off but explicitly assigned to their original DE1 pins. Every
exposed port has a location assignment and 3.3-V LVTTL I/O standard. Unused
board resources are not top-level ports. Set SW0 **before resetting**; mode is
synchronized and latched a few clocks after reset release, so changes during a
replay take effect only after another reset.

The SDC defines the 20 ns clock, cuts asynchronous port paths only to their
first synchronizer stages, and leaves inter-stage timing intact. Raw KEY0
reset assertion is asynchronous and release passes through two registers.
UART TX and LEDs have zero-delay output bounds relative to CLOCK_50, with no
external synchronous capture requirement. Verify that wildcard synchronizer
names resolve and review reset recovery/removal and all timing exceptions in
TimeQuest after synthesis. No timing result is inferred from simulation.

## Compile and program on Windows

1. Install **Quartus II 13.0 SP1 Web Edition** with Cyclone II device support
   and the USB-Blaster driver. Copy the repository with `fpga/rtl/` and
   `fpga/quartus/` relative paths preserved.
2. Open `fpga/quartus/de1.qpf`. Confirm top `top`, device `EP2C20F484C7`, all
   eight RTL files, SDC and pin/I/O assignments. Start Compilation. A command
   prompt with Quartus `bin` on PATH can instead run:
   ```bat
   cd fpga\quartus
   quartus_sh --flow compile de1
   ```
3. Inspect synthesis/fitter warnings, multiplier/logic usage, pin report and
   TimeQuest. Confirm the 50 MHz clock, resolved CDC exceptions, no unexpected
   unconstrained synchronous paths, and passing setup/hold/recovery/removal.
   If 50 MHz does not close, pipeline the reported arithmetic path and rerun
   the exact numerical simulations; do not assume timing closure from RTL.
4. Power the original DE1, connect its **USB-Blaster** USB cable, set RUN/PROG
   to RUN for JTAG, and open Tools → Programmer. Select USB-Blaster, JTAG,
   Auto Detect; add `output_files/de1.sof`, select Program/Configure and Start.
   This configures SRAM and is lost on power-off. Flash programming is outside
   this MVP. Never substitute a DE1-SoC or DE2 project.
5. Connect a separate **USB-to-RS-232 adapter** to the DE1 onboard DB9 RS-232
   connector. The USB-Blaster programs the FPGA; it is not this design's UART
   transport. Use RS-232 electrical levels at the DB9, not a bare TTL USB UART.
   Confirm the adapter/cable TX/RX/GND wiring; a null-modem crossover may be
   required for the chosen adapter. No hardware flow control is used.
6. Install Python and `pip install -r fpga/requirements.txt`. Identify the
   serial adapter using `python -m serial.tools.list_ports` (e.g. COM3 on
   Windows or `/dev/cu.usbserial-...` on macOS).

## Physical communication and detection checklist

Run these commands from the repository root, substituting the actual port.
They are documented hardware steps and have **not** been performed here.

1. Set SW0=1, press and release KEY0. Check heartbeat LEDG[7] and cleared red
   LEDs. Run the full echo smoke test first:
   ```bash
   python fpga/tools/replay.py --port COM3 --input simulator/data/normal.bin \
     --speed 1 --echo --output fpga/build/echo.json
   ```
   Repeat with `grid_oscillation.bin` and `isolated.bin`, resetting each time.
   Require `PASS echo`, byte-for-byte equality and LEDR[4] OFF before trying
   detection on physical hardware. Echo mode publishes no detection results;
   its JSON record list is empty, and its `.raw.bin` capture contains the echo.
2. Set SW0=0 and reset. Run:
   ```bash
   python fpga/tools/replay.py --port COM3 --input simulator/data/grid_oscillation.bin \
     --speed 1 --output fpga/build/grid_hardware.json
   ```
   LEDR[5] becomes valid after 20 simulated seconds. Require 12 decoded records,
   LEDR[4] OFF and the settled alarm pattern above. Reset and repeat for normal
   and isolated. Use separate output names to retain captures.
3. Compare captured JSON with the test-only reference, for example:
   ```bash
   python - <<'PY'
   import json, sys
   sys.path.insert(0, 'fpga/tools')
   from reference_detector import detect, read_measurements
   actual = json.load(open('fpga/build/grid_hardware.json'))
   expected = list(detect(read_measurements('simulator/data/grid_oscillation.bin')))
   assert actual == expected, 'FAIL hardware numerical comparison'
   print('PASS hardware numerical comparison')
   PY
   ```
   The snippet uses a POSIX shell; on Windows save it as a Python file or use
   an equivalent Python session. Reference detection is separate from replay.
4. Accelerated runs are explicitly **simulated replay**:
   ```bash
   python fpga/tools/replay.py --port COM3 --input simulator/data/grid_oscillation.bin \
     --speed 10 --output fpga/build/grid_fast.csv
   ```
   Speed 1 sends four packets every 1/30 second. Higher speed preserves order
   and caps the rate to 115200 8N1 bandwidth with a 5% margin (about 13× max).
   Wall-clock windows shorten; energy uses the original 30 Hz simulation sample
   indices and is unchanged. No measurements are regenerated or altered.

The replay reader runs concurrently with writes, handles short writes, captures
raw replies, and saves JSON or CSV. It checks result identities and counts but
never computes detector energies. It refuses to overwrite the input. On errors
it saves partial diagnostics and exits nonzero. Opening a serial port does not
reset the FPGA; manually set mode and press KEY0 before each run. A latched
LEDR[4] means all results from that replay must be treated as invalid, even if
previously transmitted packets look valid. The fixed result protocol has no
remote status/clear command.
