#!/usr/bin/env bash
set -Eeuo pipefail

root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
cd "$root"

usage() {
    cat <<'HELP'
Usage: bash start.sh [--skip-program | --reference] [--lan WIFI_IPV4]

By default, compile and program the DE1, then run the hardware-backed dashboard.
--skip-program  Use the already programmed DE1.
--reference     Run without the board, using the Python detector.
--lan IPV4      Start the Windows relay on the ThinkPad's Wi-Fi IPv4 address.

Overrides: QUARTUS_BIN (Windows directory), JTAG_CABLE (default 1),
JTAG_DEVICE (default 1), PYTHON (WSL interpreter), WINDOWS_NODE (Windows executable).
Ctrl+C stops the services started by this script.
HELP
}

detector=hardware
program=yes
lan_ip=
while (($#)); do
    case "$1" in
        --skip-program) program=no ;;
        --reference) detector=reference; program=no ;;
        --lan)
            if [[ $# -lt 2 || ! $2 =~ ^([0-9]{1,3}\.){3}[0-9]{1,3}$ ]]; then
                echo '--lan requires the ThinkPad Wi-Fi IPv4 address.' >&2
                exit 2
            fi
            lan_ip=$2
            shift
            ;;
        -h|--help) usage; exit 0 ;;
        *) usage >&2; exit 2 ;;
    esac
    shift
done

mkdir -p fpga/build
exec 9>fpga/build/start.lock
if ! flock -n 9; then
    echo 'This project launcher is already running.' >&2
    exit 1
fi

pids=()
relay_pid=
windows() {
    powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$windows_helper" "$@"
}
cleanup() {
    if (("${#pids[@]}")); then
        kill "${pids[@]}" 2>/dev/null || true
        wait "${pids[@]}" 2>/dev/null || true
    fi
    if [[ -n $relay_pid ]]; then
        windows -Action StopRelay -RelayPid "$relay_pid" || true
    fi
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

if [[ $detector == hardware || -n $lan_ip ]]; then
    command -v powershell.exe >/dev/null || { echo 'Run this script from WSL with Windows interoperability enabled.' >&2; exit 1; }
    windows_helper=$(wslpath -w "$root/fpga/tools/start_windows.ps1")
fi

python=${PYTHON:-}
if [[ -z $python ]]; then
    if [[ -x "$root/.venv/bin/python" ]]; then
        python="$root/.venv/bin/python"
    elif [[ -x "$root/fpga/.venv/bin/python" ]]; then
        python="$root/fpga/.venv/bin/python"
    else
        python3 -m venv "$root/.venv"
        python="$root/.venv/bin/python"
    fi
fi
if ! "$python" -c 'import fastapi, numpy, openai, dotenv, uvicorn, websockets' >/dev/null 2>&1; then
    "$python" -m pip install -r simulator/requirements.txt
fi

if command -v node >/dev/null && command -v npm >/dev/null; then
    npm_command=(npm)
elif [[ -x "$root/fpga/build/node-linux/bin/node" && -f "$root/fpga/build/npm/bin/npm-cli.js" ]]; then
    export PATH="$root/fpga/build/node-linux/bin:$PATH"
    npm_command=(node "$root/fpga/build/npm/bin/npm-cli.js")
else
    echo 'Install Node.js 20.9 or newer with npm in WSL.' >&2
    exit 1
fi

for port in 8000 3000; do
    if (echo >/dev/tcp/127.0.0.1/"$port") 2>/dev/null; then
        echo "Port $port is already in use. Stop that listener before starting this project." >&2
        exit 1
    fi
done

export NEXT_TELEMETRY_DISABLED=1 PYTHONDONTWRITEBYTECODE=1
(
    cd frontend
    if [[ ! -x node_modules/.bin/next || package-lock.json -nt node_modules/.package-lock.json ]]; then
        "${npm_command[@]}" ci
    fi
    "${npm_command[@]}" run build
)

quartus_bin=${QUARTUS_BIN:-'C:\altera\13.0sp1\quartus\bin64'}
if [[ $program == yes ]]; then
    windows -Action Program -QuartusBin "$quartus_bin" \
        -ProjectDir "$(wslpath -w "$root/fpga/quartus")" \
        -Cable "${JTAG_CABLE:-1}" -Device "${JTAG_DEVICE:-1}"
fi
export SIM_DETECTOR="$detector"
if [[ $detector == hardware ]]; then
    export SIM_QUARTUS_STP
    SIM_QUARTUS_STP=$(wslpath -u "${quartus_bin%\\}\\quartus_stp.exe")
fi

wait_for_http() {
    local url=$1 pid=$2
    for ((attempt=0; attempt<40; attempt++)); do
        if curl --max-time 1 -fsS "$url" >/dev/null 2>&1; then return 0; fi
        if ! kill -0 "$pid" 2>/dev/null; then break; fi
        sleep 0.5
    done
    echo "Service failed to become ready at $url" >&2
    return 1
}

"$python" -m uvicorn simulator.app:app --host 127.0.0.1 --port 8000 &
pids+=("$!")
wait_for_http http://127.0.0.1:8000/api/health "$!"
(
    cd frontend
    exec node_modules/.bin/next start -H 127.0.0.1 -p 3000
) &
pids+=("$!")
wait_for_http http://127.0.0.1:3000/api/health "$!"

if [[ -n $lan_ip ]]; then
    windows_node=${WINDOWS_NODE:-}
    if [[ -z $windows_node && -f fpga/build/node-windows/bin/node.exe ]]; then
        windows_node=$(wslpath -w "$root/fpga/build/node-windows/bin/node.exe")
    fi
    relay_args=(-Action StartRelay -ScriptPath "$(wslpath -w "$root/frontend/lan.mjs")" -ListenIp "$lan_ip")
    if [[ -n $windows_node ]]; then relay_args+=(-NodePath "$windows_node"); fi
    relay_pid_file="$root/fpga/build/relay.pid"
    : >"$relay_pid_file"
    windows "${relay_args[@]}" -PidFile "$(wslpath -w "$relay_pid_file")" &
    relay_launcher=$!
    for ((attempt=0; attempt<40; attempt++)); do
        if [[ -s $relay_pid_file ]]; then
            relay_pid=$(<"$relay_pid_file")
            break
        fi
        if ! kill -0 "$relay_launcher" 2>/dev/null; then break; fi
        sleep 0.25
    done
    if [[ ! $relay_pid =~ ^[0-9]+$ ]]; then
        echo 'The Windows Wi-Fi relay did not start.' >&2
        exit 1
    fi
    windows -Action CheckRelay -ListenIp "$lan_ip"
    echo "Wi-Fi dashboard: http://$lan_ip:3000"
fi
echo 'Dashboard: http://localhost:3000'
echo 'Press Ctrl+C to stop the dashboard and simulator.'
wait -n "${pids[@]}"
