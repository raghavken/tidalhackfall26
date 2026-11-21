"""Synthetic PMU data generator for the Oscillation Cartographer project."""

from .packet_encoder import (
    PACKET_SIZE,
    decode_packet,
    decode_stream,
    encode_packet,
    encode_records,
)
from .scenarios import (
    SAMPLE_RATE_HZ,
    SCENARIOS,
    STATIONS,
    generate_data,
    generate_frequencies,
)

__all__ = [
    "PACKET_SIZE",
    "SAMPLE_RATE_HZ",
    "SCENARIOS",
    "STATIONS",
    "decode_packet",
    "decode_stream",
    "encode_packet",
    "encode_records",
    "generate_data",
    "generate_frequencies",
]
