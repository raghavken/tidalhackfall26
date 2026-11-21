"""Host-side Virtual JTAG replay shared by both dashboards."""
from pathlib import Path
import subprocess
from tempfile import TemporaryDirectory
from time import monotonic, sleep

TOOLS = Path(__file__).resolve().parent

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
