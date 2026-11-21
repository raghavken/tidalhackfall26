"""REST + WebSocket tests using FastAPI's TestClient (no network needed)."""

import json
import os
import sys
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from threading import Thread
from unittest.mock import patch

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, ROOT)

from fastapi.testclient import TestClient  # noqa: E402

from simulator.app import create_app  # noqa: E402


def client(**kwargs):
    kwargs.setdefault("seed", 1)
    kwargs.setdefault("speed", 20)  # 20x real time keeps tests fast
    return TestClient(create_app(**kwargs))


def read_samples(ws, count):
    """Read WebSocket messages until `count` samples have arrived."""
    samples = []
    while len(samples) < count:
        msg = ws.receive_json()
        if msg["type"] == "samples":
            samples.extend(msg["samples"])
    return samples[:count]


class TestRest(unittest.TestCase):
    def test_health_config_state(self):
        with client() as c:
            self.assertEqual(c.get("/api/health").json(), {"status": "ok"})
            cfg = c.get("/api/config").json()
            self.assertEqual([s["name"] for s in cfg["stations"]], ["North", "East", "South", "West"])
            self.assertEqual(cfg["severities"]["severe"]["amplitude_mhz"], 30.0)
            self.assertEqual(cfg["energy_threshold"], 2_250_000)
            st = c.get("/api/state").json()
            self.assertEqual(st["severities"]["North"], "normal")

    def test_set_and_clear_anomaly(self):
        with client() as c:
            r = c.put("/api/anomaly", json={"North": "severe", "South": "mild"})
            self.assertEqual(r.status_code, 200)
            self.assertEqual(r.json()["severities"],
                             {"North": "severe", "East": "normal", "South": "mild", "West": "normal"})
            # PUT replaces the whole configuration
            r = c.put("/api/anomaly", json={"West": "moderate"})
            self.assertEqual(r.json()["severities"]["North"], "normal")
            r = c.delete("/api/anomaly")
            self.assertEqual(set(r.json()["severities"].values()), {"normal"})

    def test_invalid_anomaly_rejected(self):
        with client() as c:
            self.assertEqual(c.put("/api/anomaly", json={"Central": "mild"}).status_code, 422)
            self.assertEqual(c.put("/api/anomaly", json={"North": "extreme"}).status_code, 422)
            self.assertEqual(c.put("/api/anomaly", json=["North"]).status_code, 422)

    def test_phase_deg(self):
        with client() as c:
            st = c.get("/api/state").json()
            self.assertEqual(st["phase_deg"]["South"], 180.0)
            r = c.put("/api/anomaly", json={"North": "severe", "phase_deg": {"South": 0}})
            self.assertEqual(r.status_code, 200)
            self.assertEqual(r.json()["phase_deg"]["South"], 0.0)
            # omitting phase_deg keeps phases; severities still replace
            r = c.put("/api/anomaly", json={"East": "mild"}).json()
            self.assertEqual(r["phase_deg"]["South"], 0.0)
            self.assertEqual(r["severities"]["North"], "normal")
            for bad in ({"phase_deg": {"North": 400}}, {"phase_deg": {"Central": 1}},
                        {"phase_deg": {"North": "x"}}):
                self.assertEqual(c.put("/api/anomaly", json=bad).status_code, 422, bad)
            # Diagnose uses the current phase
            c.put("/api/anomaly", json={"North": "severe", "South": "severe",
                                        "phase_deg": {"South": 0}})
            d = c.post("/api/diagnose").json()
            self.assertEqual(d["analysis"]["phase_relationships"][0]["relationship"], "in_phase")

    def test_status(self):
        no_model = {"NEMOTRON_BASE_URL": "", "NEMOTRON_MODEL": "", "SIM_QUARTUS_STP": ""}
        with patch.dict(os.environ, no_model), client() as c:
            s = c.get("/api/status").json()
            self.assertEqual(s["fpga"]["detector"], "reference")
            self.assertTrue(s["fpga"]["available"])
            self.assertEqual(s["fpga"]["state"], "idle")
            self.assertIsNone(s["fpga"]["last_diagnosis_id"])
            self.assertEqual(s["nemotron"]["state"], "not_configured")
            self.assertIsNone(s["nemotron"]["model"])
            d = c.post("/api/diagnose").json()
            self.assertIsInstance(d["run_ms"], int)
            s = c.get("/api/status").json()
            self.assertEqual(s["fpga"]["state"], "idle")
            self.assertEqual(s["fpga"]["last_diagnosis_id"], 1)
            self.assertIsInstance(s["fpga"]["last_run_ms"], int)
            # Explain without a configured model: 503, Nemotron shows not_configured
            self.assertEqual(c.post("/api/diagnoses/1/explain").status_code, 503)
            self.assertEqual(c.get("/api/status").json()["nemotron"]["state"], "not_configured")
        with patch.dict(os.environ, no_model), client(detector="hardware") as c:
            self.assertFalse(c.get("/api/status").json()["fpga"]["available"])
            self.assertEqual(c.post("/api/diagnose").status_code, 503)
            s = c.get("/api/status").json()["fpga"]
            self.assertEqual(s["state"], "error")
            self.assertIn("not configured", s["last_error"])
        with patch.dict(os.environ, {"SIM_QUARTUS_STP": "/mnt/c/quartus_stp.exe"}), \
                client(detector="hardware") as c:
            self.assertTrue(c.get("/api/status").json()["fpga"]["available"])

    def test_nemotron_status_flow(self):
        """ready -> thinking -> ready around an explanation, pushed over the WebSocket."""
        class Model(BaseHTTPRequestHandler):
            def do_POST(self):
                self.rfile.read(int(self.headers["Content-Length"]))
                body = json.dumps({"id": "t", "object": "chat.completion", "created": 0, "model": "m",
                                   "choices": [{"index": 0, "finish_reason": "stop",
                                                "message": {"role": "assistant", "content": "ok"}}]}).encode()
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

            def log_message(self, *args):
                pass

        with ThreadingHTTPServer(("127.0.0.1", 0), Model) as server:
            Thread(target=server.serve_forever, daemon=True).start()
            env = {"NEMOTRON_BASE_URL": f"http://127.0.0.1:{server.server_port}/v1",
                   "NEMOTRON_MODEL": "test-nemotron"}
            try:
                with patch.dict(os.environ, env), client() as c, c.websocket_connect("/ws/stream") as ws:
                    hello = ws.receive_json()
                    self.assertEqual(hello["status"]["nemotron"]["state"], "ready")
                    self.assertEqual(hello["status"]["nemotron"]["model"], "test-nemotron")
                    d = c.post("/api/diagnose").json()
                    self.assertEqual(c.post(f"/api/diagnoses/{d['diagnosis_id']}/explain").status_code, 200)
                    states, explanation = [], None
                    for _ in range(500):
                        msg = ws.receive_json()
                        if msg["type"] == "status":
                            states.append(msg["status"]["nemotron"]["state"])
                        if msg["type"] == "explanation":
                            explanation = msg["explanation"]
                        if explanation and states[-1:] == ["ready"] and "thinking" in states:
                            break
                    self.assertIn("thinking", states)
                    self.assertEqual(states[-1], "ready")
                    self.assertEqual(explanation["analysis"], "ok")
                    self.assertEqual(c.get("/api/status").json()["nemotron"]["last_diagnosis_id"],
                                     d["diagnosis_id"])
            finally:
                server.shutdown()

    def test_explain_with_facility_context(self):
        """Optional context (frontend Phase 2) reaches the model as grid_context."""
        seen = []

        class Model(BaseHTTPRequestHandler):
            def do_POST(self):
                seen.append(json.loads(self.rfile.read(int(self.headers["Content-Length"]))))
                body = json.dumps({"id": "t", "object": "chat.completion", "created": 0, "model": "m",
                                   "choices": [{"index": 0, "finish_reason": "stop",
                                                "message": {"role": "assistant", "content": "ok"}}]}).encode()
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

            def log_message(self, *args):
                pass

        with ThreadingHTTPServer(("127.0.0.1", 0), Model) as server:
            Thread(target=server.serve_forever, daemon=True).start()
            env = {"NEMOTRON_BASE_URL": f"http://127.0.0.1:{server.server_port}/v1", "NEMOTRON_MODEL": "m"}
            try:
                with patch.dict(os.environ, env), client() as c:
                    c.put("/api/anomaly", json={"North": "severe"})
                    d = c.post("/api/diagnose").json()
                    context = {"critical_facilities": {"stations": {"North": {
                        "substation": "Jack Creek", "nearest_substation_for": [{"category": "Hospitals"}]}}}}
                    r = c.post(f"/api/diagnoses/{d['diagnosis_id']}/explain", json={"context": context})
                    self.assertEqual(r.status_code, 200, r.text)
                    r = c.post(f"/api/diagnoses/{d['diagnosis_id']}/explain")  # no body still works
                    self.assertEqual(r.status_code, 200, r.text)
                    self.assertEqual(c.post(f"/api/diagnoses/{d['diagnosis_id']}/explain",
                                            json={"bogus": 1}).status_code, 422)
            finally:
                server.shutdown()
        with_ctx = json.loads(seen[0]["messages"][1]["content"])
        self.assertEqual(with_ctx["grid_context"], context)
        self.assertIn("grid_context", seen[0]["messages"][0]["content"])  # prompt explains it
        self.assertNotIn("grid_context", json.loads(seen[1]["messages"][1]["content"]))

    def test_pause_resume_reset(self):
        with client() as c:
            self.assertFalse(c.post("/api/stream/pause").json()["running"])
            self.assertTrue(c.post("/api/stream/resume").json()["running"])
            c.put("/api/anomaly", json={"East": "mild"})
            r = c.post("/api/stream/reset", json={"seed": 9}).json()
            self.assertEqual(r["seed"], 9)
            self.assertEqual(r["sample_index"], 0)
            self.assertEqual(r["severities"]["East"], "mild")  # settings survive reset
            self.assertEqual(c.post("/api/stream/reset").status_code, 200)

    def test_diagnose(self):
        with client() as c:
            c.put("/api/anomaly", json={"North": "severe", "South": "moderate"})
            d = c.post("/api/diagnose").json()
            self.assertEqual(len(d["fpga_results"]), 4)
            self.assertEqual({r["station"]: r["severity"] for r in d["fpga_results"]},
                             {"North": "severe", "East": "normal", "South": "moderate", "West": "normal"})
            self.assertEqual(d["window"]["packets"], 2400)
            self.assertTrue(d["matches_request"])
            c.post("/api/diagnose")
            history = c.get("/api/diagnoses").json()
            self.assertEqual([h["diagnosis_id"] for h in history], [1, 2])

    def test_hardware_detector_not_configured(self):
        with client(detector="hardware") as c:
            r = c.post("/api/diagnose")
            self.assertEqual(r.status_code, 503)


class TestWebSocket(unittest.TestCase):
    def test_hello_then_batched_samples(self):
        with client(batch=3) as c, c.websocket_connect("/ws/stream") as ws:
            hello = ws.receive_json()
            self.assertEqual(hello["type"], "hello")
            self.assertIn("config", hello)
            self.assertIn("history", hello)
            msg = ws.receive_json()
            while msg["type"] != "samples":
                msg = ws.receive_json()
            self.assertEqual(len(msg["samples"]), 3)
            s = msg["samples"][0]
            self.assertEqual(len(s["deviation_mhz"]), 4)
            self.assertEqual(len(s["frequency_hz"]), 4)

    def test_samples_continuous(self):
        with client() as c, c.websocket_connect("/ws/stream") as ws:
            ws.receive_json()
            samples = read_samples(ws, 60)
            idx = [s["sample_index"] for s in samples]
            self.assertEqual(idx, list(range(idx[0], idx[0] + 60)))

    def test_two_clients_see_identical_samples(self):
        with client() as c:
            with c.websocket_connect("/ws/stream") as a, c.websocket_connect("/ws/stream") as b:
                a.receive_json()
                b.receive_json()
                sa = {s["sample_index"]: s for s in read_samples(a, 60)}
                sb = {s["sample_index"]: s for s in read_samples(b, 60)}
                common = set(sa) & set(sb)
                self.assertGreater(len(common), 30)
                for i in common:
                    self.assertEqual(sa[i], sb[i])

    def test_state_and_diagnosis_pushed(self):
        with client() as c, c.websocket_connect("/ws/stream") as ws:
            hello = ws.receive_json()
            self.assertEqual(hello["status"]["fpga"]["state"], "idle")
            c.put("/api/anomaly", json={"West": "severe"})
            c.post("/api/diagnose")
            seen, fpga_states = {}, []
            for _ in range(500):
                msg = ws.receive_json()
                if msg["type"] in ("state", "diagnosis"):
                    seen[msg["type"]] = msg
                if msg["type"] == "status":
                    fpga_states.append(msg["status"]["fpga"]["state"])
                if len(seen) == 2 and fpga_states[-1:] == ["idle"]:
                    break
            self.assertEqual(fpga_states, ["diagnosing", "idle"])
            self.assertEqual(seen["state"]["state"]["severities"]["West"], "severe")
            self.assertEqual(len(seen["diagnosis"]["window"]), 600)
            self.assertEqual(seen["diagnosis"]["diagnosis"]["fpga_results"][3]["severity"], "severe")

    def test_new_client_gets_history(self):
        with client() as c:
            c.post("/api/stream/pause")
            hub = c.app.state.hub
            for _ in range(650):  # > 20 s of data, generated directly (no timing race)
                hub.sim.next_sample()
            with c.websocket_connect("/ws/stream") as ws:
                hello = ws.receive_json()
                self.assertEqual(len(hello["history"]), 600)
                self.assertEqual(hello["history"][-1]["sample_index"], hub.sim.sample_index - 1)


if __name__ == "__main__":
    unittest.main()
