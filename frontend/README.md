# Live Next.js dashboard

The ThinkPad runs the simulator and talks to the DE1 over USB-Blaster.
A browser on the same Wi-Fi renders the waveform locally. Future Three.js
views can use the same WebSocket feed.

## Start on the ThinkPad

In WSL, from the repository root, install the simulator dependencies into
your Python environment and start FastAPI. Use the Quartus path installed
on the ThinkPad and a DE1 programmed with the Virtual JTAG image.

```bash
python -m pip install -r simulator/requirements.txt
SIM_DETECTOR=hardware SIM_QUARTUS_STP=/mnt/c/altera/13.0sp1/quartus/bin64/quartus_stp.exe python -m uvicorn simulator.app:app --host 127.0.0.1 --port 8000
```

Without the hardware environment variables, Diagnose uses the Python
reference. The dashboard displays the selected detector.

In another WSL terminal with Node.js 20.9 or later:

```bash
cd frontend
npm ci
npm run build
npm start
```

Open [localhost:3000](http://localhost:3000) on the ThinkPad. To enable access
over Wi-Fi with the default WSL NAT setup, run the relay from the repository
root in Windows PowerShell with Windows Node.js installed. Replace the
example address with the ThinkPad's Wi-Fi IPv4 address from `ipconfig`.

```powershell
node frontend/lan.mjs 192.168.1.20
```

Open `http://192.168.1.20:3000` on the other computer using that same address.
The relay binds to that Windows interface and forwards to WSL Next.js.
Next.js proxies REST and WebSocket traffic to FastAPI over loopback.
If Windows blocks incoming requests, allow TCP 3000 from the Wi-Fi subnet
on the Wi-Fi interface. Clients share the simulator and its controls, so use
a trusted network. A Wi-Fi network with client isolation can block access.

## Use the dashboard

Set phase in degrees and severity per station, then choose **Apply settings**.
Choose **Diagnose** to run a fresh 600-sample window. In hardware mode, the
ThinkPad sends 2,400 packets to the DE1 and checks the four returned packets.
The waveform continues streaming during the hardware run.
