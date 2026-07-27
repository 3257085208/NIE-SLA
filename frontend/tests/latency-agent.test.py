#!/usr/bin/env python3
import importlib.util
import os
import socket
import time


os.environ.setdefault("NSTATUS_LATENCY_API_BASE", "https://api.example.test")
os.environ.setdefault("NSTATUS_LATENCY_TOKEN", "test-token")
os.environ.setdefault("NSTATUS_LATENCY_NODE_ID", "test-node")
os.environ.setdefault("NSTATUS_LATENCY_INSTALL_BASE", "https://status.example.test")

spec = importlib.util.spec_from_file_location("latency_agent", os.path.join(os.path.dirname(__file__), "..", "latency-agent.py"))
latency_agent = importlib.util.module_from_spec(spec)
spec.loader.exec_module(latency_agent)

original_getaddrinfo = latency_agent.socket.getaddrinfo
original_socket = latency_agent.socket.socket


class FakeSocket:
    def __init__(self, *_):
        self.timeout = None

    def settimeout(self, timeout):
        self.timeout = timeout

    def connect(self, sockaddr):
        if sockaddr[0] == "slow.example":
            time.sleep(0.35)
            raise TimeoutError("slow address")
        if sockaddr[0] == "timeout.example":
            time.sleep(1.2)
            raise TimeoutError("timed out")
        time.sleep(0.02)

    def close(self):
        pass


def fake_getaddrinfo(host, port, type=socket.SOCK_STREAM):
    del type
    if host == "race.example":
        return [
            (socket.AF_INET, socket.SOCK_STREAM, 6, "", ("slow.example", port)),
            (socket.AF_INET6, socket.SOCK_STREAM, 6, "", ("fast.example", port, 0, 0)),
        ]
    return [(socket.AF_INET, socket.SOCK_STREAM, 6, "", ("timeout.example", port))]


try:
    latency_agent.socket.getaddrinfo = fake_getaddrinfo
    latency_agent.socket.socket = FakeSocket

    started = time.monotonic()
    raced = latency_agent.probe({"id": "race", "target_host": "race.example", "target_port": 443, "timeout_ms": 1000})
    elapsed = time.monotonic() - started
    assert raced["ok"] is True, raced
    assert raced["latency_ms"] < 200, raced
    assert elapsed < 0.25, elapsed

    started = time.monotonic()
    timed_out = latency_agent.probe({"id": "timeout", "target_host": "timeout.example", "target_port": 443, "timeout_ms": 1000})
    elapsed = time.monotonic() - started
    assert timed_out["ok"] is False, timed_out
    assert timed_out["latency_ms"] is None, timed_out
    assert elapsed < 1.1, elapsed
finally:
    latency_agent.socket.getaddrinfo = original_getaddrinfo
    latency_agent.socket.socket = original_socket

print("external Latency agent strict-timeout tests passed")
