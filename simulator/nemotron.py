"""Explain recorded PMU evidence using a local OpenAI-compatible model."""
import json
import os
from pathlib import Path

from dotenv import dotenv_values
from openai import APIError, AsyncOpenAI

from .diagnose import evidence_only

ENV_FILE = Path(__file__).resolve().parents[1] / ".env"

SYSTEM_PROMPT = """You are the power-grid diagnostic assistant for Oscillation Cartographer,
a four-substation PMU simulator. Interpret the recorded 0.25 Hz frequency
oscillation evidence. Identify the affected stations, compare their measured
severity and amplitude, and explain phase relationships between alarmed
stations. In-phase or opposite-phase movement can suggest a shared oscillation
mode but does not establish a source or a real grid topology. Distinguish
detector results from backend phase and amplitude estimates. Use the supplied
window and detector type, acknowledge missing or uncertain evidence, and do
not invent causes, topology, equipment conditions, or live utility data.
If grid_context lists critical facilities near the alarmed substations, say
which could be affected, and note that it is a proximity estimate, not
confirmed service areas. Give a short assessment, the key measurements
supporting it, and one diagnostic follow-up. Use plain text and keep the answer under 180 words."""


class ModelUnavailable(RuntimeError):
    """Configuration or inference error suitable for the dashboard."""

    def __init__(self, message, status_code=503):
        super().__init__(message)
        self.status_code = status_code


def configured_model():
    """The configured model name, or None if NEMOTRON_BASE_URL/MODEL are missing."""
    settings = dotenv_values(ENV_FILE, interpolate=False)

    def setting(name):
        return (os.environ.get(name, settings.get(name)) or "").strip()

    return setting("NEMOTRON_MODEL") if setting("NEMOTRON_BASE_URL") and setting("NEMOTRON_MODEL") else None


async def explain_diagnosis(diagnosis, config, context=None):
    settings = dotenv_values(ENV_FILE, interpolate=False)

    def setting(name, default=""):
        return (os.environ.get(name, settings.get(name)) or "").strip() or default

    base_url = setting("NEMOTRON_BASE_URL")
    model = setting("NEMOTRON_MODEL")
    if not base_url or not model:
        raise ModelUnavailable("Set NEMOTRON_BASE_URL and NEMOTRON_MODEL in the backend .env.")
    try:
        timeout = float(setting("NEMOTRON_TIMEOUT_SECONDS", "90"))
        max_tokens = int(setting("NEMOTRON_MAX_TOKENS", "2048"))
        if not 0 < timeout < float("inf") or max_tokens < 1:
            raise ValueError
    except ValueError as exc:
        raise ModelUnavailable("Set a positive timeout and token limit in the backend .env.") from exc

    evidence = {
        "environment": "Synthetic PMU simulator, nominal frequency 60 Hz",
        "substations": [{"id": s["station_id"], "name": s["name"]} for s in config["stations"]],
        "sample_rate_hz": config["sample_rate_hz"],
        "target_oscillation_hz": config["oscillation_frequency_hz"],
        "alarm_energy_threshold": config["energy_threshold"],
        "severity_bands": config["severities"],
        "diagnosis": evidence_only(diagnosis),
    }
    if context:
        evidence["grid_context"] = context
    try:
        async with AsyncOpenAI(base_url=base_url, api_key=setting("NEMOTRON_API_KEY", "local"),
                               timeout=timeout, max_retries=0) as client:
            response = await client.chat.completions.create(
                model=model,
                messages=[{"role": "system", "content": SYSTEM_PROMPT},
                          {"role": "user", "content": json.dumps(evidence)}],
                max_tokens=max_tokens,
            )
    except (APIError, ValueError) as exc:
        raise ModelUnavailable("Nemotron inference failed. Check the model server and backend settings.",
                               status_code=502) from exc
    text = response.choices[0].message.content if response.choices else None
    if not text or not text.strip():
        raise ModelUnavailable("Nemotron returned no analysis. Check the model and token limit.",
                               status_code=502)
    return {"diagnosis_id": diagnosis["diagnosis_id"], "model": model, "analysis": text.strip()}
