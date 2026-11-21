"""
Command-line entry point for the synthetic PMU data generator.

Examples:
    python simulator/generate.py --scenario all
    python simulator/generate.py --scenario grid_oscillation --plot
    python simulator/generate.py --scenario isolated --seed 7 --duration 40
"""

import argparse
import csv
import os
import sys

# Allow running this file directly (python simulator/generate.py) as well as
# importing it as part of the `simulator` package.
if __package__ in (None, ""):
    sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from simulator.packet_encoder import write_binary  # noqa: E402
from simulator.scenarios import (  # noqa: E402
    CSV_COLUMNS,
    DEFAULT_DURATION_S,
    DEFAULT_OSC_FREQUENCY_HZ,
    DEFAULT_SEED,
    DEFAULT_START_TIME_S,
    NOMINAL_FREQUENCY_HZ,
    SCENARIOS,
    STATION_NAMES,
    generate_data,
)

DEFAULT_OUTPUT_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "data")

# Validated categorical palette (fixed order: one hue per station ID).
STATION_COLORS = ["#2a78d6", "#eb6834", "#1baf7a", "#eda100"]

SCENARIO_TITLES = {
    "normal": "Normal operation",
    "grid_oscillation": "Inter-area oscillation",
    "isolated": "Isolated anomaly (North only)",
}


def write_csv(records, path):
    """Write records to CSV with fixed 6-decimal formatting for floats."""
    with open(path, "w", newline="") as f:
        writer = csv.writer(f)
        writer.writerow(CSV_COLUMNS)
        for r in records:
            writer.writerow(
                [
                    r["sample_index"],
                    f"{r['time_seconds']:.6f}",
                    r["station_id"],
                    r["station"],
                    f"{r['frequency_hz']:.6f}",
                    r["deviation_mhz"],
                ]
            )


def read_csv(path):
    """Read a CSV written by write_csv back into a list of records."""
    with open(path, newline="") as f:
        return [
            {
                "sample_index": int(row["sample_index"]),
                "time_seconds": float(row["time_seconds"]),
                "station_id": int(row["station_id"]),
                "station": row["station"],
                "frequency_hz": float(row["frequency_hz"]),
                "deviation_mhz": int(row["deviation_mhz"]),
            }
            for row in csv.DictReader(f)
        ]


def plot_records(records, scenario, start_time, path):
    """Save a PNG of all four stations' frequency against time."""
    import matplotlib

    matplotlib.use("Agg")  # no display needed; works headless on any OS
    import matplotlib.pyplot as plt

    fig, ax = plt.subplots(figsize=(12, 5), dpi=120)
    ax.axhline(NOMINAL_FREQUENCY_HZ, color="#888888", linewidth=1, linestyle="--",
               label="60 Hz nominal", zorder=1)
    if scenario != "normal":
        ax.axvline(start_time, color="#444444", linewidth=1, linestyle=":",
                   label=f"Disturbance start ({start_time:g} s)", zorder=1)

    for sid, name in enumerate(STATION_NAMES):
        rows = [r for r in records if r["station_id"] == sid]
        ax.plot(
            [r["time_seconds"] for r in rows],
            [r["frequency_hz"] for r in rows],
            color=STATION_COLORS[sid],
            linewidth=1.2,
            label=f"{sid} {name}",
            zorder=2,
        )

    ax.ticklabel_format(axis="y", useOffset=False)  # show 59.98, not "+6e1"
    ax.set_xlabel("Time (s)")
    ax.set_ylabel("Frequency (Hz)")
    ax.set_title(f"Synthetic PMU frequency - {SCENARIO_TITLES[scenario]}")
    ax.grid(True, color="#e5e5e5", linewidth=0.6)
    ax.set_axisbelow(True)
    for spine in ("top", "right"):
        ax.spines[spine].set_visible(False)
    # Legend sits below the axes so it never hides oscillation peaks.
    ax.legend(loc="upper center", bbox_to_anchor=(0.5, -0.12), ncol=6,
              fontsize=9, frameon=False)
    fig.tight_layout()
    fig.savefig(path)
    plt.close(fig)


def run_scenario(scenario, args):
    """Generate one scenario and write its CSV, BIN and (optionally) PNG."""
    records = generate_data(
        scenario=scenario,
        duration=args.duration,
        seed=args.seed,
        start_time=args.start_time,
        osc_frequency=args.osc_frequency,
    )
    base = os.path.join(args.output_dir, scenario)
    write_csv(records, base + ".csv")
    write_binary(records, base + ".bin")
    outputs = [base + ".csv", base + ".bin"]
    if args.plot:
        plot_records(records, scenario, args.start_time, base + ".png")
        outputs.append(base + ".png")
    print(f"[{scenario}] {len(records)} records -> " + ", ".join(outputs))


def build_parser():
    p = argparse.ArgumentParser(description="Synthetic 4-station PMU data generator")
    p.add_argument("--scenario", required=True, choices=list(SCENARIOS) + ["all"])
    p.add_argument("--duration", type=float, default=DEFAULT_DURATION_S,
                   help="simulation length in seconds (default: %(default)s)")
    p.add_argument("--seed", type=int, default=DEFAULT_SEED,
                   help="random seed (default: %(default)s)")
    p.add_argument("--start-time", type=float, default=DEFAULT_START_TIME_S,
                   help="disturbance start time in seconds (default: %(default)s)")
    p.add_argument("--osc-frequency", type=float, default=DEFAULT_OSC_FREQUENCY_HZ,
                   help="oscillation frequency in Hz (default: %(default)s)")
    p.add_argument("--output-dir", default=DEFAULT_OUTPUT_DIR,
                   help="where to write files (default: simulator/data)")
    p.add_argument("--plot", action="store_true", help="also save a PNG plot")
    return p


def main(argv=None):
    args = build_parser().parse_args(argv)
    os.makedirs(args.output_dir, exist_ok=True)
    scenarios = SCENARIOS if args.scenario == "all" else (args.scenario,)
    try:
        for scenario in scenarios:
            run_scenario(scenario, args)
    except ValueError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 2
    return 0


if __name__ == "__main__":
    sys.exit(main())
