#!/usr/bin/env python3
"""Independent NStatus external Latency probe node."""

import concurrent.futures
import json
import os
import socket
import sys
import time
import urllib.parse
import urllib.request


API_BASE = os.environ["NSTATUS_LATENCY_API_BASE"].rstrip("/")
TOKEN = os.environ["NSTATUS_LATENCY_TOKEN"]
NODE_ID = os.environ["NSTATUS_LATENCY_NODE_ID"]
INTERVAL = max(30, min(600, int(os.environ.get("NSTATUS_LATENCY_INTERVAL_SEC", "60"))))
USER_AGENT = os.environ.get("NSTATUS_LATENCY_USER_AGENT", "NStatus-Latency/1.0")


def api(path, payload=None):
    body = None if payload is None else json.dumps(payload, separators=(",", ":")).encode()
    request = urllib.request.Request(
        API_BASE + path,
        data=body,
        headers={
            "Authorization": "Bearer " + TOKEN,
            "Content-Type": "application/json",
            "Accept": "application/json",
            "User-Agent": USER_AGENT,
        },
        method="GET" if payload is None else "POST",
    )
    with urllib.request.urlopen(request, timeout=30) as response:
        return json.load(response)


def probe(target):
    started = time.monotonic()
    timeout = max(0.5, min(30, int(target.get("timeout_ms", 5000)) / 1000))
    try:
        with socket.create_connection((target["target_host"], int(target["target_port"])), timeout=timeout):
            latency = round((time.monotonic() - started) * 1000)
        return {"target_id": target["id"], "checked_at": int(time.time()), "latency_ms": latency, "ok": True}
    except (OSError, ValueError) as error:
        return {"target_id": target.get("id", ""), "checked_at": int(time.time()), "latency_ms": None, "ok": False, "error": str(error)[:160]}


def run_once():
    data = api("/api/latency-agent/targets?node_id=" + urllib.parse.quote(NODE_ID))
    targets = data.get("targets", []) if data.get("ok") else []
    with concurrent.futures.ThreadPoolExecutor(max_workers=min(20, max(1, len(targets)))) as pool:
        results = list(pool.map(probe, targets))
    submitted = api("/api/latency-agent/results", {"node_id": NODE_ID, "results": results}) if results else {"ok": True, "accepted": 0}
    if not submitted.get("ok"):
        raise RuntimeError(submitted.get("error") or "Latency result submission failed")
    return {"targets": len(targets), "accepted": int(submitted.get("accepted", 0))}


def main():
    if sys.argv[1:] == ["--once"]:
        print(json.dumps({"ok": True, **run_once()}, separators=(",", ":")), flush=True)
        return
    while True:
        started = time.monotonic()
        try:
            run_once()
        except Exception as error:
            print("latency probe cycle failed:", error, flush=True)
        time.sleep(max(1, INTERVAL - (time.monotonic() - started)))


if __name__ == "__main__":
    main()
