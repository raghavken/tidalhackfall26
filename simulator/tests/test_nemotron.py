import json
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from threading import Thread

from fastapi.testclient import TestClient

from simulator.app import create_app


def test_explains_only_observed_diagnosis(monkeypatch):
    requests = []

    class Model(BaseHTTPRequestHandler):
        def do_POST(self):
            requests.append((self.path, json.loads(self.rfile.read(int(self.headers["Content-Length"])))))
            body = json.dumps({
                "id": "test", "object": "chat.completion", "created": 0, "model": "test-nemotron",
                "choices": [{"index": 0, "finish_reason": "stop",
                             "message": {"role": "assistant", "content": "North shows an oscillation."}}],
            }).encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

    with ThreadingHTTPServer(("127.0.0.1", 0), Model) as server:
        worker = Thread(target=server.serve_forever, daemon=True)
        worker.start()
        monkeypatch.setenv("NEMOTRON_BASE_URL", f"http://127.0.0.1:{server.server_port}/v1")
        monkeypatch.setenv("NEMOTRON_MODEL", "test-nemotron")
        try:
            with TestClient(create_app(seed=10, detector="reference")) as client:
                assert client.put("/api/anomaly", json={"North": "severe", "South": "mild"}).is_success
                result = client.post("/api/diagnose").json()
                response = client.post(f"/api/diagnoses/{result['diagnosis_id']}/explain")
                assert response.status_code == 200, response.text
                assert response.json()["analysis"] == "North shows an oscillation."
                assert client.post("/api/diagnoses/999/explain").status_code == 404
        finally:
            server.shutdown()
            worker.join()

    path, request = requests.pop()
    assert path == "/v1/chat/completions"
    assert request["model"] == "test-nemotron"
    system, user = request["messages"]
    assert "power-grid diagnostic assistant" in system["content"]
    evidence = json.loads(user["content"])
    assert [station["name"] for station in evidence["substations"]] == ["North", "East", "South", "West"]
    assert evidence["diagnosis"]["fpga_results"] == result["fpga_results"]
    assert "requested" not in evidence["diagnosis"]
    assert "matches_request" not in evidence["diagnosis"]
