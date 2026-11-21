"""
Live PMU simulator server: REST controls + WebSocket stream + Diagnose.

Run from the repository root:
    uvicorn simulator.app:app --reload --port 8000

Settings (environment variables, since uvicorn owns the command line):
    SIM_SEED      integer seed for the live stream (default: random)
    SIM_BATCH     samples per WebSocket message (default: 3 -> 10 messages/s)
    SIM_DETECTOR  "reference" (default) or "hardware"
    SIM_SPEED     time multiplier, for testing only (default: 1 = real time)
"""

import asyncio
import os
import threading
import time
from collections import deque
from contextlib import asynccontextmanager
from typing import Literal, Optional

import numpy as np
from fastapi import FastAPI, HTTPException, WebSocket, WebSocketDisconnect
from fastapi.concurrency import run_in_threadpool
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, ConfigDict, Field

from .detectors import DetectorUnavailable, detector_available, get_detector
from .diagnose import run_diagnosis
from .live_sim import (
    ENERGY_THRESHOLD,
    OSC_FREQUENCY_HZ,
    SAMPLE_RATE_HZ,
    SEVERITIES,
    STATIONS,
    WINDOW_SAMPLES,
    LiveSimulator,
)

HELLO_HISTORY_SAMPLES = WINDOW_SAMPLES  # 20 s of history for new clients
MAX_DIAGNOSES = 20
CLIENT_QUEUE_SIZE = 300  # messages; a client this far behind is disconnected

Severity = Literal["normal", "mild", "moderate", "severe"]
Phase = Optional[float]


class PhaseRequest(BaseModel):
    """Per-station phase in degrees (-360..360). Omitted stations keep their phase."""
    model_config = ConfigDict(extra="forbid")
    North: Phase = Field(default=None, ge=-360, le=360)
    East: Phase = Field(default=None, ge=-360, le=360)
    South: Phase = Field(default=None, ge=-360, le=360)
    West: Phase = Field(default=None, ge=-360, le=360)

    def as_config(self):
        return {k: v for k, v in self.model_dump().items() if v is not None}


class AnomalyRequest(BaseModel):
    """Per-station severity (omitted = normal) plus optional phase changes."""
    model_config = ConfigDict(extra="forbid")
    North: Optional[Severity] = None
    East: Optional[Severity] = None
    South: Optional[Severity] = None
    West: Optional[Severity] = None
    phase_deg: Optional[PhaseRequest] = None

    def severities(self):
        return {k: v for k, v in self.model_dump(exclude={"phase_deg"}).items() if v is not None}


class ResetRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    seed: Optional[int] = None


def _env_int(name, default):
    value = os.environ.get(name)
    return default if value in (None, "") else int(value)


class Hub:
    """Shared server state: the simulator, connected clients, diagnoses, status."""

    def __init__(self, seed, batch, detector_name, speed):
        if batch < 1:
            raise ValueError("batch must be at least 1")
        if speed <= 0:
            raise ValueError("speed must be positive")
        self.batch = batch
        self.speed = speed
        self.detector_name = detector_name
        get_detector(detector_name)  # fail fast on a bad name
        self.sim = LiveSimulator(seed)
        self.paused = False
        self.clients = set()  # one asyncio.Queue per WebSocket
        self.diagnoses = deque(maxlen=MAX_DIAGNOSES)
        self.next_diagnosis_id = 1
        self._diagnose_rng = np.random.default_rng()  # fresh noise on every press
        self._diagnose_lock = threading.Lock()
        self._pending = []
        self.fpga = {"state": "idle", "last_diagnosis_id": None,
                     "last_run_ms": None, "last_error": None}

    # -- messages -----------------------------------------------------------
    def config(self):
        return {
            "stations": STATIONS,
            "sample_rate_hz": SAMPLE_RATE_HZ,
            "oscillation_frequency_hz": OSC_FREQUENCY_HZ,
            "window_samples": WINDOW_SAMPLES,
            "energy_threshold": ENERGY_THRESHOLD,
            "severities": SEVERITIES,
            "samples_per_message": self.batch,
            "detector": self.detector_name,
        }

    def state(self):
        return {
            "running": not self.paused,
            "sample_index": self.sim.sample_index,
            "time_seconds": round(self.sim.sample_index / SAMPLE_RATE_HZ, 3),
            "severities": dict(self.sim.severities),
            "phase_deg": dict(self.sim.phase_deg),
            "seed": self.sim.seed,
            "clients": len(self.clients),
        }

    def status(self):
        return {
            "stream": {"running": not self.paused, "clients": len(self.clients),
                       "sample_index": self.sim.sample_index},
            "fpga": {"detector": self.detector_name,
                     "available": detector_available(self.detector_name), **self.fpga},
            "nemotron": {"state": "not_connected", "detail": "Agent not built yet"},
        }

    def broadcast(self, message):
        for queue in list(self.clients):
            try:
                queue.put_nowait(message)
            except asyncio.QueueFull:  # client too slow: drop it
                self.clients.discard(queue)
                _force_close(queue)

    def broadcast_status(self):
        self.broadcast({"type": "status", "status": self.status()})

    # -- generator loop -----------------------------------------------------
    def tick(self):
        """Generate one sample; broadcast when a batch is full."""
        self._pending.append(self.sim.next_sample())
        if len(self._pending) >= self.batch:
            self.broadcast({"type": "samples", "samples": self._pending})
            self._pending = []

    async def run(self):
        period = 1.0 / (SAMPLE_RATE_HZ * self.speed)
        deadline = time.monotonic()
        while True:
            delay = deadline - time.monotonic()
            if delay > 0:
                await asyncio.sleep(delay)
            if not self.paused:
                self.tick()
            # Never burst catch-up samples after a stall.
            deadline = max(deadline + period, time.monotonic())

    # -- actions ------------------------------------------------------------
    def set_anomaly(self, severities, phase_deg):
        self.sim.set_severities(severities)
        if phase_deg:
            self.sim.set_phases(phase_deg)
        self.broadcast({"type": "state", "state": self.state()})

    def set_paused(self, paused):
        self.paused = paused
        self.broadcast({"type": "state", "state": self.state()})
        self.broadcast_status()

    def reset(self, seed):
        severities, phases = self.sim.severities, self.sim.phase_deg
        self.sim = LiveSimulator(seed)
        self.sim.set_severities(severities)
        self.sim.set_phases(phases)
        self._pending = []
        self.broadcast({"type": "reset", "state": self.state()})

    def diagnose(self, severities, phase_deg):
        """Runs in a worker thread (CPU work must not block the stream)."""
        with self._diagnose_lock:
            diagnosis_id = self.next_diagnosis_id
            self.next_diagnosis_id += 1
            return run_diagnosis(severities, self._diagnose_rng,
                                 get_detector(self.detector_name), diagnosis_id, phase_deg)


def _force_close(queue):
    """Tell a client's sender task to stop by emptying its queue and adding None."""
    while not queue.empty():
        queue.get_nowait()
    queue.put_nowait(None)


def create_app(seed=None, batch=None, detector=None, speed=None):
    hub = Hub(
        seed=seed if seed is not None else (_env_int("SIM_SEED", None)),
        batch=batch if batch is not None else _env_int("SIM_BATCH", 3),
        detector_name=detector or os.environ.get("SIM_DETECTOR", "reference"),
        speed=speed if speed is not None else float(os.environ.get("SIM_SPEED", "1")),
    )

    @asynccontextmanager
    async def lifespan(app):
        task = asyncio.create_task(hub.run())
        try:
            yield
        finally:
            task.cancel()

    app = FastAPI(title="Oscillation Cartographer — Live PMU Simulator", lifespan=lifespan)
    app.state.hub = hub
    app.add_middleware(
        CORSMiddleware,
        allow_origin_regex=r"https?://(localhost|127\.0\.0\.1)(:\d+)?",
        allow_methods=["*"],
        allow_headers=["*"],
    )

    # -- REST ---------------------------------------------------------------
    @app.get("/api/health")
    async def health():
        return {"status": "ok"}

    @app.get("/api/config")
    async def get_config():
        return hub.config()

    @app.get("/api/state")
    async def get_state():
        return hub.state()

    @app.get("/api/status")
    async def get_status():
        return hub.status()

    @app.put("/api/anomaly")
    async def put_anomaly(request: AnomalyRequest):
        phases = request.phase_deg.as_config() if request.phase_deg else None
        hub.set_anomaly(request.severities(), phases)
        return hub.state()

    @app.delete("/api/anomaly")
    async def clear_anomaly():
        hub.set_anomaly({}, None)
        return hub.state()

    @app.post("/api/stream/pause")
    async def pause():
        hub.set_paused(True)
        return hub.state()

    @app.post("/api/stream/resume")
    async def resume():
        hub.set_paused(False)
        return hub.state()

    @app.post("/api/stream/reset")
    async def reset(request: Optional[ResetRequest] = None):
        hub.reset(request.seed if request else None)
        return hub.state()

    @app.post("/api/diagnose")
    async def diagnose():
        if hub.fpga["state"] == "diagnosing":
            raise HTTPException(status_code=409, detail="A diagnosis is already running")
        severities, phases = dict(hub.sim.severities), dict(hub.sim.phase_deg)
        hub.fpga.update(state="diagnosing", last_error=None)
        hub.broadcast_status()
        started = time.perf_counter()
        try:
            diagnosis, window = await run_in_threadpool(hub.diagnose, severities, phases)
        except DetectorUnavailable as exc:
            hub.fpga.update(state="error", last_error=str(exc))
            hub.broadcast_status()
            raise HTTPException(status_code=503, detail=str(exc))
        except Exception as exc:
            hub.fpga.update(state="error", last_error=str(exc))
            hub.broadcast_status()
            raise
        elapsed_ms = round((time.perf_counter() - started) * 1000)
        diagnosis["run_ms"] = elapsed_ms
        hub.fpga.update(state="idle", last_diagnosis_id=diagnosis["diagnosis_id"],
                        last_run_ms=elapsed_ms)
        hub.diagnoses.append(diagnosis)
        hub.broadcast({"type": "diagnosis", "diagnosis": diagnosis, "window": window})
        hub.broadcast_status()
        return diagnosis

    @app.get("/api/diagnoses")
    async def list_diagnoses():
        return list(hub.diagnoses)

    # -- WebSocket ------------------------------------------------------------
    @app.websocket("/ws/stream")
    async def stream(ws: WebSocket):
        await ws.accept()
        queue = asyncio.Queue(maxsize=CLIENT_QUEUE_SIZE)
        hub.clients.add(queue)
        await ws.send_json({"type": "hello", "config": hub.config(), "state": hub.state(),
                            "status": hub.status(),
                            "history": hub.sim.recent(HELLO_HISTORY_SAMPLES)})

        async def sender():
            while True:
                message = await queue.get()
                if message is None:  # too slow: disconnected by the hub
                    await ws.close(code=1013)
                    return
                await ws.send_json(message)

        send_task = asyncio.create_task(sender())
        try:
            while True:
                receive = asyncio.create_task(ws.receive_text())
                done, _ = await asyncio.wait({receive, send_task},
                                             return_when=asyncio.FIRST_COMPLETED)
                if send_task in done:
                    receive.cancel()
                    break
                receive.result()  # client messages are ignored; raises on disconnect
        except (WebSocketDisconnect, RuntimeError):
            pass
        finally:
            hub.clients.discard(queue)
            send_task.cancel()

    return app


app = create_app()
