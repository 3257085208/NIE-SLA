#!/usr/bin/env python3
"""
NStatus external probe agent.

This is intended for a small home node such as OrangePi Zero 3. It pulls the
target list from the Worker with AGENT_TOKEN, checks targets locally, then
uploads one batch result every interval.
"""

from __future__ import annotations

import argparse
import concurrent.futures
import json
import os
import socket
import ssl
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from typing import Any


DEFAULT_AGENT_ID = "external-probe"
DEFAULT_AGENT_LABEL = "External Probe"


def main() -> int:
    parser = argparse.ArgumentParser(description="NStatus OrangePi external probe agent")
    parser.add_argument("--api", default=os.getenv("NSTATUS_API_BASE", "").rstrip("/"), help="Worker API base URL, e.g. https://sla-api.example.com")
    parser.add_argument("--token", default=os.getenv("NSTATUS_AGENT_TOKEN", ""), help="AGENT_TOKEN secret")
    parser.add_argument("--agent-id", default=os.getenv("NSTATUS_AGENT_ID", DEFAULT_AGENT_ID))
    parser.add_argument("--agent-label", default=os.getenv("NSTATUS_AGENT_LABEL", DEFAULT_AGENT_LABEL))
    parser.add_argument("--once", action="store_true", help="Run one check batch and exit")
    parser.add_argument("--interval", type=int, default=int(os.getenv("NSTATUS_INTERVAL_SEC", "300")))
    parser.add_argument("--concurrency", type=int, default=int(os.getenv("NSTATUS_CONCURRENCY", "8")))
    args = parser.parse_args()

    if not args.api:
        print("Missing --api or NSTATUS_API_BASE", file=sys.stderr)
        return 2
    if not args.token:
        print("Missing --token or NSTATUS_AGENT_TOKEN", file=sys.stderr)
        return 2

    while True:
        started = time.time()
        try:
            targets_payload = api_json(args.api, "/api/agent/targets", args.token, method="GET", query={"agent_id": args.agent_id})
            targets = targets_payload.get("targets") or []
            interval = int(targets_payload.get("interval_sec") or args.interval or 300)
            results = run_checks(targets, args.concurrency)
            submit = {
                "agent_id": args.agent_id,
                "agent_label": args.agent_label,
                "submitted_at": int(time.time()),
                "results": results,
            }
            response = api_json(args.api, "/api/agent/results", args.token, method="POST", payload=submit)
            print(json.dumps({
                "ok": True,
                "targets": len(targets),
                "results": len(results),
                "accepted": response.get("accepted"),
                "rejected": len(response.get("rejected") or []),
            }, ensure_ascii=False))
        except Exception as exc:
            print(json.dumps({"ok": False, "error": str(exc)}, ensure_ascii=False), file=sys.stderr)

        if args.once:
            return 0

        elapsed = time.time() - started
        time.sleep(max(5, interval - elapsed))


def run_checks(targets: list[dict[str, Any]], concurrency: int) -> list[dict[str, Any]]:
    workers = max(1, min(int(concurrency or 8), 32))
    with concurrent.futures.ThreadPoolExecutor(max_workers=workers) as pool:
        return list(pool.map(check_target, targets))


def check_target(target: dict[str, Any]) -> dict[str, Any]:
    checked_at = int(time.time() // 300 * 300)
    try:
        if target.get("type") == "tcp":
            result = check_tcp(target)
        elif target.get("type") == "http":
            result = check_http(target)
        else:
            result = {"ok": False, "latency_ms": None, "status_code": None, "error": "unsupported target type"}
    except Exception as exc:
        result = {"ok": False, "latency_ms": None, "status_code": None, "error": str(exc)}

    return {
        "target_id": target.get("id"),
        "checked_at": checked_at,
        **result,
    }


def check_tcp(target: dict[str, Any]) -> dict[str, Any]:
    host = str(target.get("target_host") or "")
    port = int(target.get("target_port") or 0)
    timeout = timeout_seconds(target)
    started = time.perf_counter()
    with socket.create_connection((host, port), timeout=timeout):
        latency_ms = round((time.perf_counter() - started) * 1000)
    return {"ok": True, "latency_ms": latency_ms, "status_code": None, "error": None}


def check_http(target: dict[str, Any]) -> dict[str, Any]:
    url = str(target.get("url") or "")
    method = str(target.get("method") or "GET").upper()
    timeout = timeout_seconds(target)
    expected = target.get("expected_status") or []
    if not isinstance(expected, list):
        expected = []

    req = urllib.request.Request(url, method=method, headers={"User-Agent": "NStatus-External-Agent/1.0"})
    started = time.perf_counter()
    try:
        with urllib.request.urlopen(req, timeout=timeout, context=ssl.create_default_context()) as res:
            status = int(res.status)
    except urllib.error.HTTPError as exc:
        status = int(exc.code)

    latency_ms = round((time.perf_counter() - started) * 1000)
    ok = status in expected if expected else 200 <= status < 400
    return {
        "ok": ok,
        "latency_ms": latency_ms,
        "status_code": status,
        "error": None if ok else f"Unexpected HTTP {status}",
    }


def timeout_seconds(target: dict[str, Any]) -> float:
    timeout_ms = int(target.get("timeout_ms") or 5000)
    return max(0.5, min(timeout_ms / 1000.0, 30.0))


def api_json(
    base: str,
    path: str,
    token: str,
    *,
    method: str,
    query: dict[str, str] | None = None,
    payload: dict[str, Any] | None = None,
) -> dict[str, Any]:
    url = base.rstrip("/") + path
    if query:
        qs = urllib.parse.urlencode(query)
        url = f"{url}?{qs}"

    data = None
    headers = {
        "Authorization": f"Bearer {token}",
        "Accept": "application/json",
        "User-Agent": "NStatus-External-Agent/1.0",
    }

    if payload is not None:
        data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        headers["Content-Type"] = "application/json; charset=utf-8"

    req = urllib.request.Request(url, data=data, method=method, headers=headers)
    with urllib.request.urlopen(req, timeout=60) as res:
        body = res.read().decode("utf-8")
        parsed = json.loads(body)
        if not parsed.get("ok"):
            raise RuntimeError(parsed.get("error") or body)
        return parsed


if __name__ == "__main__":
    raise SystemExit(main())
