"""
FPGA-compatible binary packet format.

Each measurement becomes one 7-byte packet (little-endian):

    byte 0    header            0xAA
    byte 1    station ID        unsigned 8-bit
    byte 2-3  sample index      unsigned 16-bit (low byte first)
    byte 4-5  deviation (mHz)   signed 16-bit two's complement (low byte first)
    byte 6    checksum          sum of bytes 0..5, modulo 256
"""

import struct

HEADER = 0xAA
PACKET_SIZE = 7

# '<' = little-endian, B = uint8, H = uint16, h = int16
_BODY_FORMAT = "<BBHh"

STATION_ID_RANGE = (0, 0xFF)
SAMPLE_INDEX_RANGE = (0, 0xFFFF)
DEVIATION_RANGE = (-32768, 32767)


def _check_range(name, value, bounds):
    low, high = bounds
    if not isinstance(value, int) or isinstance(value, bool):
        raise TypeError(f"{name} must be an int, got {type(value).__name__}")
    if not low <= value <= high:
        raise ValueError(f"{name}={value} does not fit in range [{low}, {high}]")


def checksum(data):
    """Sum of the given bytes, modulo 256."""
    return sum(data) % 256


def encode_packet(station_id, sample_index, deviation_mhz):
    """Encode one measurement into a 7-byte packet."""
    _check_range("station_id", station_id, STATION_ID_RANGE)
    _check_range("sample_index", sample_index, SAMPLE_INDEX_RANGE)
    _check_range("deviation_mhz", deviation_mhz, DEVIATION_RANGE)
    body = struct.pack(_BODY_FORMAT, HEADER, station_id, sample_index, deviation_mhz)
    return body + bytes([checksum(body)])


def decode_packet(packet):
    """Decode a 7-byte packet. Raises ValueError on a bad header or checksum."""
    if len(packet) != PACKET_SIZE:
        raise ValueError(f"packet must be {PACKET_SIZE} bytes, got {len(packet)}")
    header, station_id, sample_index, deviation = struct.unpack(
        _BODY_FORMAT, packet[:6]
    )
    if header != HEADER:
        raise ValueError(f"bad header byte 0x{header:02X}")
    if checksum(packet[:6]) != packet[6]:
        raise ValueError("checksum mismatch")
    return {
        "station_id": station_id,
        "sample_index": sample_index,
        "deviation_mhz": deviation,
    }


def encode_records(records):
    """Encode a list of measurement records (dicts) into one bytes object."""
    return b"".join(
        encode_packet(r["station_id"], r["sample_index"], r["deviation_mhz"])
        for r in records
    )


def decode_stream(data):
    """Decode a whole binary file's contents into a list of packet dicts."""
    if len(data) % PACKET_SIZE != 0:
        raise ValueError(
            f"stream length {len(data)} is not a multiple of {PACKET_SIZE}"
        )
    return [
        decode_packet(data[i : i + PACKET_SIZE])
        for i in range(0, len(data), PACKET_SIZE)
    ]


def write_binary(records, path):
    """Write records to `path` as consecutive 7-byte packets."""
    with open(path, "wb") as f:
        f.write(encode_records(records))


def read_binary(path):
    """Read and decode a binary packet file."""
    with open(path, "rb") as f:
        return decode_stream(f.read())
