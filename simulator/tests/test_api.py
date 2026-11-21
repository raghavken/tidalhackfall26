"""REST + WebSocket tests using FastAPI's TestClient (no network needed)."""

import os
import sys
import unittest

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
            ws.receive_json()
            c.put("/api/anomaly", json={"West": "severe"})
            c.post("/api/diagnose")
            seen = {}
            for _ in range(500):
                msg = ws.receive_json()
                if msg["type"] in ("state", "diagnosis"):
                    seen[msg["type"]] = msg
                if len(seen) == 2:
                    break
            self.assertEqual(seen["state"]["state"]["severities"]["West"], "severe")
            self.assertEqual(len(seen["diagnosis"]["window"]), 600)
            self.assertEqual(seen["diagnosis"]["diagnosis"]["fpga_results"][3]["severity"], "severe")

    def test_new_client_gets_history(self):
        with client(speed=200) as c:
            with c.websocket_connect("/ws/stream") as ws:
                ws.receive_json()
                read_samples(ws, 650)  # let > 20 s of data accumulate
            with c.websocket_connect("/ws/stream") as ws2:
                hello = ws2.receive_json()
                self.assertEqual(len(hello["history"]), 600)


if __name__ == "__main__":
    unittest.main()
