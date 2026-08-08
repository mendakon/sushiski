#!/usr/bin/env python3
"""Tail nginx misskey-metrics.jsonl and export path-bucketed latency histograms."""

from __future__ import annotations

import json
import os
import re
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from prometheus_client import CONTENT_TYPE_LATEST, Counter, Histogram, generate_latest

LOG_PATH = os.environ.get("NGINX_METRICS_LOG", "/var/log/nginx/misskey-metrics.log")
BIND = os.environ.get("BIND", "0.0.0.0")
PORT = int(os.environ.get("PORT", "4040"))

BUCKETS = (0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1.0, 2.5, 5.0, 10.0, 30.0)

REQ = Histogram(
    "nginx_misskey_request_seconds",
    "nginx $request_time by route bucket",
    ["route", "method", "status_class"],
    buckets=BUCKETS,
)
UPSTREAM = Histogram(
    "nginx_misskey_upstream_seconds",
    "nginx $upstream_response_time by route bucket",
    ["route", "method", "status_class"],
    buckets=BUCKETS,
)
LINES = Counter("nginx_misskey_log_lines_total", "Parsed / skipped log lines", ["result"])
SLOW = Counter(
    "nginx_misskey_slow_requests_total",
    "Requests slower than threshold",
    ["route", "kind"],
)

API_KEEP = {
    "notes",
    "i",
    "users",
    "following",
    "followers",
    "clips",
    "channels",
    "drive",
    "charts",
    "meta",
    "stats",
    "admin",
    "federation",
    "ap",
    "auth",
    "renotes",
    "reactions",
    "notifications",
    "pages",
    "flash",
    "gallery",
    "antenna",
    "antennas",
    "hashtags",
    "emoji",
    "emojis",
    "server-info",
}


def status_class(code: int) -> str:
    if code < 200:
        return "1xx"
    if code < 300:
        return "2xx"
    if code < 400:
        return "3xx"
    if code < 500:
        return "4xx"
    return "5xx"


def route_of(uri: str, host: str) -> str:
    if host.startswith("media."):
        return "media"
    path = uri.split("?", 1)[0]
    if path == "/healthz" or path.startswith("/healthz"):
        return "healthz"
    if path.startswith("/streaming"):
        return "streaming"
    if path == "/inbox" or path.endswith("/inbox"):
        return "inbox"
    if path.startswith("/api/"):
        parts = [p for p in path.split("/") if p]
        # api / notes / timeline -> api/notes/timeline (max 3)
        if len(parts) >= 2:
            a = parts[1]
            if a not in API_KEEP:
                a = "_other"
            if len(parts) >= 3:
                b = parts[2]
                # collapse ids
                if re.fullmatch(r"[0-9a-z]{6,}", b) or b.startswith("a"):
                    return f"api/{a}/:id"
                return f"api/{a}/{b}"
            return f"api/{a}"
        return "api"
    if path.startswith("/files") or path.startswith("/proxy"):
        return "files"
    if path.startswith("/url"):
        return "url-preview"
    if path.startswith("/assets") or path.startswith("/static") or path.startswith("/vite"):
        return "static"
    if path.startswith("/@"):  # user page
        return "user-page"
    if path == "/" or path.startswith("/my") or path.startswith("/share"):
        return "frontend"
    return "other"


def parse_upstream(raw: str) -> float | None:
    if not raw or raw == "-":
        return None
    # multiple upstreams: "0.1, 0.2" → sum
    parts = []
    for p in raw.split(","):
        p = p.strip()
        if not p or p == "-":
            continue
        try:
            parts.append(float(p))
        except ValueError:
            continue
    if not parts:
        return None
    return sum(parts)


def handle_line(line: str) -> None:
    line = line.strip()
    if not line:
        return
    try:
        obj = json.loads(line)
    except json.JSONDecodeError:
        LINES.labels(result="bad_json").inc()
        return
    try:
        status = int(obj.get("status", 0))
        method = str(obj.get("method", "?"))[:16]
        uri = str(obj.get("uri", "/"))
        host = str(obj.get("host", ""))
        rt = float(obj.get("request_time", 0))
        urt = parse_upstream(str(obj.get("upstream_time", "-")))
    except (TypeError, ValueError):
        LINES.labels(result="bad_fields").inc()
        return

    route = route_of(uri, host)
    sc = status_class(status)

    # websocket / long-poll: request_time is connection length — don't pollute latency
    if route == "streaming":
        LINES.labels(result="streaming_skip_hist").inc()
        if rt >= 1:
            SLOW.labels(route=route, kind="request").inc()
        return

    REQ.labels(route=route, method=method, status_class=sc).observe(rt)
    if urt is not None:
        UPSTREAM.labels(route=route, method=method, status_class=sc).observe(urt)
    if rt >= 1:
        SLOW.labels(route=route, kind="request").inc()
    if urt is not None and urt >= 1:
        SLOW.labels(route=route, kind="upstream").inc()
    LINES.labels(result="ok").inc()


def follow(path: str):
    """Tail -F style follow."""
    while True:
        try:
            with open(path, "r", encoding="utf-8", errors="replace") as f:
                f.seek(0, os.SEEK_END)
                while True:
                    line = f.readline()
                    if line:
                        handle_line(line)
                        continue
                    # rotated?
                    try:
                        if os.stat(path).st_ino != os.fstat(f.fileno()).st_ino:
                            break
                    except FileNotFoundError:
                        break
                    time.sleep(0.2)
        except FileNotFoundError:
            time.sleep(1)


class Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):
        return

    def do_GET(self):
        if self.path.split("?")[0] not in ("/metrics", "/"):
            self.send_response(404)
            self.end_headers()
            return
        data = generate_latest()
        self.send_response(200)
        self.send_header("Content-Type", CONTENT_TYPE_LATEST)
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)


def main():
    import threading

    threading.Thread(target=follow, args=(LOG_PATH,), name="tail", daemon=True).start()
    print(f"nginx-log-exporter on {BIND}:{PORT} tailing {LOG_PATH}", flush=True)
    ThreadingHTTPServer((BIND, PORT), Handler).serve_forever()


if __name__ == "__main__":
    main()
