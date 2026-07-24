#!/usr/bin/env python3
"""Independent NIE-SLA external Latency probe node."""

import concurrent.futures
import hashlib
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
UPDATE_INTERVAL = max(300, min(86400, int(os.environ.get("NSTATUS_LATENCY_UPDATE_CHECK_SEC", "3600"))))
INSTALL_BASE = os.environ["NSTATUS_LATENCY_INSTALL_BASE"].rstrip("/")
USER_AGENT = os.environ.get("NSTATUS_LATENCY_USER_AGENT", "NIE-SLA-Latency/1.0")
SCRIPT_PATH = os.path.realpath(__file__)
SCRIPT_VERSION = "4"


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


def update_policy():
    return api("/api/latency-agent/update-policy?node_id=" + urllib.parse.quote(NODE_ID))


def update_if_needed():
    policy = update_policy()
    check_interval = max(300, min(86400, int(policy.get("check_interval_sec", UPDATE_INTERVAL))))
    if not policy.get("auto_update"):
        return check_interval

    script_version = str(policy.get("script_version", SCRIPT_VERSION))
    if not script_version.isdigit():
        raise RuntimeError("invalid Latency agent update version")
    update_url = INSTALL_BASE + "/latency-agent.py?v=" + urllib.parse.quote(script_version)
    if urllib.parse.urlparse(update_url).scheme != "https":
        raise RuntimeError("Latency agent automatic updates require HTTPS")
    request = urllib.request.Request(
        update_url,
        headers={"Accept": "text/x-python, text/plain", "User-Agent": USER_AGENT},
        method="GET",
    )
    with urllib.request.urlopen(request, timeout=30) as response:
        candidate = response.read(1024 * 1024 + 1)
    if not candidate or len(candidate) > 1024 * 1024:
        raise RuntimeError("invalid Latency agent update size")

    with open(SCRIPT_PATH, "rb") as current_file:
        current = current_file.read()
    if hashlib.sha256(candidate).digest() == hashlib.sha256(current).digest():
        return check_interval

    source = candidate.decode("utf-8")
    compile(source, SCRIPT_PATH, "exec")
    next_path = SCRIPT_PATH + ".next"
    try:
        with open(next_path, "wb") as next_file:
            next_file.write(candidate)
            next_file.flush()
            os.fsync(next_file.fileno())
        os.chmod(next_path, 0o755)
        os.replace(next_path, SCRIPT_PATH)
    finally:
        try:
            os.unlink(next_path)
        except FileNotFoundError:
            pass

    print("Latency agent updated; restarting", flush=True)
    os.execv(sys.executable, [sys.executable, SCRIPT_PATH])
    return check_interval


def main():
    if sys.argv[1:] == ["--once"]:
        print(json.dumps({"ok": True, **run_once()}, separators=(",", ":")), flush=True)
        return
    next_update = time.monotonic()
    while True:
        started = time.monotonic()
        try:
            run_once()
        except Exception as error:
            print("latency probe cycle failed:", error, flush=True)
        now = time.monotonic()
        if now >= next_update:
            try:
                next_update = now + update_if_needed()
            except Exception as error:
                print("latency agent update check failed:", error, flush=True)
                next_update = now + UPDATE_INTERVAL
        sleep_for = min(INTERVAL - (time.monotonic() - started), next_update - time.monotonic())
        time.sleep(max(1, sleep_for))


if __name__ == "__main__":
    main()
