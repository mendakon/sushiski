#!/usr/bin/env python3
"""App host → Postgres latency for Prometheus (SELECT 1 over the live path)."""

from __future__ import annotations

import os
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import psycopg
from prometheus_client import CONTENT_TYPE_LATEST, CollectorRegistry, Counter, Gauge, Histogram, generate_latest

CONFIG_PATH = Path(os.environ.get("MISSKEY_DEFAULT_YML", "/config/default.yml"))
INTERVAL_SEC = float(os.environ.get("PING_INTERVAL_SEC", "2"))
RECONNECT_EVERY = int(os.environ.get("RECONNECT_EVERY", "15"))
BIND = os.environ.get("BIND", "0.0.0.0")
PORT = int(os.environ.get("PORT", "9104"))

QUERY_BUCKETS = (0.005, 0.01, 0.015, 0.02, 0.025, 0.03, 0.04, 0.05, 0.075, 0.1, 0.15, 0.2, 0.3, 0.5, 1.0, 2.0)
CONNECT_BUCKETS = (0.02, 0.05, 0.1, 0.15, 0.2, 0.3, 0.4, 0.5, 0.75, 1.0, 2.0, 5.0)

registry = CollectorRegistry()
query_hist = Histogram(
    "sushiski_pg_query_seconds",
    "SELECT 1 on a reused connection (App→DB query RTT)",
    buckets=QUERY_BUCKETS,
    registry=registry,
)
connect_hist = Histogram(
    "sushiski_pg_connect_seconds",
    "New Postgres connection time including auth",
    buckets=CONNECT_BUCKETS,
    registry=registry,
)
query_last = Gauge("sushiski_pg_query_last_seconds", "Last SELECT 1 duration", registry=registry)
connect_last = Gauge("sushiski_pg_connect_last_seconds", "Last connect duration", registry=registry)
up = Gauge("sushiski_pg_up", "1 if last ping succeeded", registry=registry)
errors = Counter("sushiski_pg_errors_total", "Failed pings", ["kind"], registry=registry)


def load_db_config(path: Path) -> dict[str, str]:
    in_db = False
    cfg: dict[str, str] = {}
    for raw in path.read_text(encoding="utf-8").splitlines():
        if raw.startswith("db:"):
            in_db = True
            continue
        if in_db:
            if raw and not raw.startswith((" ", "\t")):
                break
            stripped = raw.strip()
            if not stripped or stripped.startswith("#") or ":" not in stripped:
                continue
            key, value = stripped.split(":", 1)
            key = key.strip()
            value = value.split("#", 1)[0].strip().strip("'\"")
            if key in {"host", "port", "db", "user", "pass"} and value:
                cfg[key] = value
    missing = [k for k in ("host", "db", "user", "pass") if k not in cfg]
    if missing:
        raise RuntimeError(f"db config missing {missing} in {path}")
    cfg.setdefault("port", "5432")
    return cfg


def connect(cfg: dict[str, str]) -> psycopg.Connection:
    return psycopg.connect(
        host=cfg["host"],
        port=int(cfg["port"]),
        dbname=cfg["db"],
        user=cfg["user"],
        password=cfg["pass"],
        connect_timeout=5,
        autocommit=True,
    )


def ping_loop() -> None:
    cfg = load_db_config(CONFIG_PATH)
    conn: psycopg.Connection | None = None
    n = 0
    while True:
        try:
            if conn is None or conn.closed or n % RECONNECT_EVERY == 0:
                if conn is not None and not conn.closed:
                    try:
                        conn.close()
                    except Exception:
                        pass
                t0 = time.perf_counter()
                conn = connect(cfg)
                dt = time.perf_counter() - t0
                connect_hist.observe(dt)
                connect_last.set(dt)
            t0 = time.perf_counter()
            with conn.cursor() as cur:
                cur.execute("SELECT 1")
                cur.fetchone()
            dt = time.perf_counter() - t0
            query_hist.observe(dt)
            query_last.set(dt)
            up.set(1)
            n += 1
        except Exception:
            up.set(0)
            errors.labels(kind="ping").inc()
            if conn is not None:
                try:
                    conn.close()
                except Exception:
                    pass
                conn = None
        time.sleep(INTERVAL_SEC)


class Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt: str, *args) -> None:
        return

    def do_GET(self) -> None:  # noqa: N802
        if self.path.split("?", 1)[0] not in {"/metrics", "/"}:
            self.send_error(404)
            return
        body = generate_latest(registry)
        self.send_response(200)
        self.send_header("Content-Type", CONTENT_TYPE_LATEST)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


def main() -> None:
    threading.Thread(target=ping_loop, name="pg-ping", daemon=True).start()
    ThreadingHTTPServer((BIND, PORT), Handler).serve_forever()


if __name__ == "__main__":
    main()
