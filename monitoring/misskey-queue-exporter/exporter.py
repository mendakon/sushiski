#!/usr/bin/env python3
"""Misskey federation queue + worker process metrics for Prometheus."""

from __future__ import annotations

import os
import re
import threading
import time
from collections import Counter, defaultdict, deque
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Deque

import redis

REDIS_HOST = os.environ.get("REDIS_HOST", "redis")
REDIS_PORT = int(os.environ.get("REDIS_PORT", "6379"))
REDIS_PASSWORD = os.environ.get("REDIS_PASSWORD") or None
REDIS_DB = int(os.environ.get("REDIS_DB", "0"))
QUEUE_PREFIX = os.environ.get("QUEUE_PREFIX", "sushi.ski")
QUEUES = [q.strip() for q in os.environ.get("QUEUES", "deliver,inbox").split(",") if q.strip()]
STATES = [
    ("active", "list"),
    ("delayed", "zset"),
    ("wait", "list"),
    ("waiting", "list"),
    ("prioritized", "zset"),
    ("paused", "list"),
    ("failed", "zset"),
    ("completed", "zset"),
]
PROCESS_WINDOW_SEC = float(os.environ.get("PROCESS_WINDOW_SEC", "10"))
HOST_TOP_N = int(os.environ.get("HOST_TOP_N", "20"))
HOST_SCAN_INTERVAL_SEC = float(os.environ.get("HOST_SCAN_INTERVAL_SEC", "60"))
BIND = os.environ.get("BIND", "0.0.0.0")
PORT = int(os.environ.get("PORT", "9101"))
PROC_DIR = os.environ.get("PROC_DIR", "/proc")

_lock = threading.Lock()
_event_totals: dict[tuple[str, str], int] = defaultdict(int)
_fail_totals: dict[tuple[str, str], int] = defaultdict(int)
_host_event_totals: dict[tuple[str, str, str], int] = defaultdict(int)
_active_times: dict[str, Deque[float]] = defaultdict(deque)
_stream_ids: dict[str, str] = {}
_stream_ok = 1
_stream_error = ""
_job_host: dict[str, str] = {}
_delayed_by_host: dict[str, dict[str, int]] = {}
_delayed_scan_ok = 1
_delayed_scan_error = ""
_delayed_scan_at = 0.0


def queue_key(queue: str, state: str) -> str:
    return f"{QUEUE_PREFIX}:queue:{queue}:{queue}:{state}"


def events_key(queue: str) -> str:
    return f"{QUEUE_PREFIX}:queue:{queue}:{queue}:events"


def job_key(queue: str, job_id: str) -> str:
    return f"{QUEUE_PREFIX}:queue:{queue}:{queue}:{job_id}"


def count_key(r: redis.Redis, key: str, kind: str) -> int:
    t = r.type(key)
    if isinstance(t, bytes):
        t = t.decode()
    if t == "none":
        return 0
    if kind == "list" or t == "list":
        return int(r.llen(key))
    if kind == "zset" or t == "zset":
        return int(r.zcard(key))
    if t == "set":
        return int(r.scard(key))
    return 0


def normalize_fail_reason(raw: str | None) -> str:
    if not raw:
        return "unknown"
    s = raw.strip().split("\n", 1)[0]
    s = s[:120]
    low = s.lower()
    if "aborterror" in low or "operation was aborted" in low:
        return "AbortError"
    if "timeout" in low or "etimedout" in low:
        return "Timeout"
    if "econnrefused" in low:
        return "ECONNREFUSED"
    if "econnreset" in low:
        return "ECONNRESET"
    if "enotfound" in low or "getaddrinfo" in low:
        return "DNS"
    if "certificate" in low or "ssl" in low or "tls" in low:
        return "TLS"
    if "status code" in low or re.search(r"\b[45]\d\d\b", s):
        return "HTTP_4xx_5xx"
    if "socket hang up" in low:
        return "SocketHangUp"
    if "cacheable" in low:
        return "cacheable-lookup"
    s = re.sub(r"\d{5,}", "N", s)
    return s[:60] or "unknown"


def normalize_host(raw: str | None) -> str:
    if not raw:
        return "unknown"
    s = raw.strip()
    # ActivityPub / inbox job names are often "host/path/..."
    if "://" in s:
        try:
            from urllib.parse import urlparse

            host = urlparse(s).hostname
            if host:
                s = host
        except Exception:
            pass
    elif "/" in s:
        s = s.split("/", 1)[0]
    elif "#" in s:
        s = s.split("#", 1)[0]
    s = s.lower()
    s = re.sub(r"[^a-z0-9._-]+", "_", s)
    return (s[:80] or "unknown")


def resolve_host(r: redis.Redis, queue: str, job_id: str | None) -> str:
    if not job_id:
        return "unknown"
    with _lock:
        cached = _job_host.get(job_id)
    if cached:
        return cached
    try:
        name = r.hget(job_key(queue, job_id), "name")
    except Exception:
        name = None
    host = normalize_host(name)
    with _lock:
        _job_host[job_id] = host
        if len(_job_host) > 20000:
            # drop arbitrary half
            for k in list(_job_host.keys())[:10000]:
                _job_host.pop(k, None)
    return host


def _note_event(r: redis.Redis, queue: str, fields: dict[str, str]) -> None:
    event = fields.get("event") or "unknown"
    job_id = fields.get("jobId")
    now = time.time()
    host = "unknown"
    if event in ("active", "completed", "failed", "stalled") and job_id:
        host = resolve_host(r, queue, job_id)

    with _lock:
        _event_totals[(queue, event)] += 1
        if event == "active":
            dq = _active_times[queue]
            dq.append(now)
            cutoff = now - PROCESS_WINDOW_SEC
            while dq and dq[0] < cutoff:
                dq.popleft()
        if event == "failed":
            reason = normalize_fail_reason(fields.get("failedReason"))
            _fail_totals[(queue, reason)] += 1
        if event in ("active", "completed", "failed") and host != "unknown":
            _host_event_totals[(queue, host, event)] += 1


def stream_worker() -> None:
    global _stream_ok, _stream_error
    while True:
        try:
            r = redis.Redis(
                host=REDIS_HOST,
                port=REDIS_PORT,
                password=REDIS_PASSWORD,
                db=REDIS_DB,
                socket_connect_timeout=5,
                socket_timeout=5,
                decode_responses=True,
            )
            r.ping()
            for q in QUEUES:
                if q not in _stream_ids:
                    try:
                        last = r.xrevrange(events_key(q), count=1)
                        _stream_ids[q] = last[0][0] if last else "0-0"
                    except Exception:
                        _stream_ids[q] = "$"
            _stream_ok = 1
            _stream_error = ""
            while True:
                streams = {events_key(q): _stream_ids.get(q, "$") for q in QUEUES}
                resp = r.xread(streams, count=200, block=2000)
                if not resp:
                    now = time.time()
                    with _lock:
                        for q in QUEUES:
                            dq = _active_times[q]
                            cutoff = now - PROCESS_WINDOW_SEC
                            while dq and dq[0] < cutoff:
                                dq.popleft()
                    continue
                for key, entries in resp:
                    parts = key.split(":")
                    queue = parts[-3] if len(parts) >= 3 else "unknown"
                    for eid, fields in entries:
                        _stream_ids[queue] = eid
                        _note_event(r, queue, fields)
        except Exception as e:
            _stream_ok = 0
            _stream_error = repr(e)
            time.sleep(2)


def delayed_host_scanner() -> None:
    global _delayed_scan_ok, _delayed_scan_error, _delayed_scan_at, _delayed_by_host
    while True:
        try:
            r = redis.Redis(
                host=REDIS_HOST,
                port=REDIS_PORT,
                password=REDIS_PASSWORD,
                db=REDIS_DB,
                socket_connect_timeout=5,
                socket_timeout=30,
                decode_responses=True,
            )
            by_queue: dict[str, dict[str, int]] = {}
            for queue in QUEUES:
                ids = r.zrange(queue_key(queue, "delayed"), 0, -1)
                counts: Counter[str] = Counter()
                # pipeline in chunks
                for i in range(0, len(ids), 200):
                    chunk = ids[i : i + 200]
                    pipe = r.pipeline()
                    for jid in chunk:
                        pipe.hget(job_key(queue, jid), "name")
                    names = pipe.execute()
                    for name in names:
                        counts[normalize_host(name)] += 1
                by_queue[queue] = dict(counts.most_common(HOST_TOP_N))
                # also keep total as special label
                by_queue[queue]["__total__"] = len(ids)
            with _lock:
                _delayed_by_host = by_queue
                _delayed_scan_ok = 1
                _delayed_scan_error = ""
                _delayed_scan_at = time.time()
            r.close()
        except Exception as e:
            with _lock:
                _delayed_scan_ok = 0
                _delayed_scan_error = repr(e)
        time.sleep(HOST_SCAN_INTERVAL_SEC)


def read_status_kb(pid: int, field: str) -> int | None:
    try:
        with open(f"{PROC_DIR}/{pid}/status", "r", encoding="utf-8") as f:
            for line in f:
                if line.startswith(field + ":"):
                    return int(line.split()[1])
    except (FileNotFoundError, ProcessLookupError, PermissionError, ValueError):
        return None
    return None


def read_smaps_anon_kb(pid: int) -> int | None:
    path = f"{PROC_DIR}/{pid}/smaps_rollup"
    try:
        with open(path, "r", encoding="utf-8") as f:
            for line in f:
                if line.startswith("Anonymous:"):
                    return int(line.split()[1])
    except (FileNotFoundError, ProcessLookupError, PermissionError, ValueError):
        pass
    try:
        total = 0
        with open(f"{PROC_DIR}/{pid}/smaps", "r", encoding="utf-8") as f:
            for line in f:
                if line.startswith("Anonymous:"):
                    total += int(line.split()[1])
        return total
    except (FileNotFoundError, ProcessLookupError, PermissionError, ValueError):
        return None


def read_starttime_ticks(pid: int) -> int | None:
    try:
        with open(f"{PROC_DIR}/{pid}/stat", "r", encoding="utf-8") as f:
            st = f.read()
        # comm can contain spaces/parens — split after last ')'
        rparen = st.rfind(")")
        if rparen < 0:
            return None
        fields = st[rparen + 2 :].split()
        # fields[19] is starttime (0-based from after state) — after ')': state is [0]? 
        # Actually after ") " the fields are: state ppid ... starttime is field index 19 in full
        # /proc/pid/stat: pid (comm) state ppid ... starttime is the 22nd field overall
        # After rparen+2, index 0 = state, ..., starttime = index 19
        return int(fields[19])
    except (FileNotFoundError, ProcessLookupError, PermissionError, ValueError, IndexError):
        return None


def read_btime() -> int | None:
    try:
        with open(f"{PROC_DIR}/stat", "r", encoding="utf-8") as f:
            for line in f:
                if line.startswith("btime "):
                    return int(line.split()[1])
    except (FileNotFoundError, PermissionError, ValueError):
        return None
    return None


def read_hz() -> int:
    # exportable override; Linux USER_HZ usually 100
    return int(os.environ.get("USER_HZ", "100"))


def discover_misskey_procs() -> list[tuple[str, int]]:
    found: list[tuple[str, int]] = []
    try:
        pids = [int(x) for x in os.listdir(PROC_DIR) if x.isdigit()]
    except FileNotFoundError:
        return found
    for pid in pids:
        try:
            with open(f"{PROC_DIR}/{pid}/cmdline", "rb") as f:
                cmd = f.read().replace(b"\x00", b" ").decode("utf-8", "replace")
        except (FileNotFoundError, ProcessLookupError, PermissionError):
            continue
        if "Misskey (worker)" in cmd:
            found.append(("worker", pid))
        elif "Misskey (master)" in cmd:
            found.append(("master", pid))
    return found


def collect_metrics() -> str:
    started = time.time()
    lines: list[str] = []
    ok = 1
    err = ""

    r = redis.Redis(
        host=REDIS_HOST,
        port=REDIS_PORT,
        password=REDIS_PASSWORD,
        db=REDIS_DB,
        socket_connect_timeout=3,
        socket_timeout=3,
        decode_responses=True,
    )
    try:
        r.ping()
        lines += [
            "# HELP misskey_queue_jobs Jobs in a Misskey BullMQ queue state",
            "# TYPE misskey_queue_jobs gauge",
        ]
        for queue in QUEUES:
            for state, kind in STATES:
                n = count_key(r, queue_key(queue, state), kind)
                lines.append(f'misskey_queue_jobs{{queue="{queue}",state="{state}"}} {n}')
            waiting = count_key(r, queue_key(queue, "wait"), "list") + count_key(
                r, queue_key(queue, "waiting"), "list"
            )
            lines.append(
                f'misskey_queue_jobs{{queue="{queue}",state="waiting_total"}} {waiting}'
            )
    except Exception as e:
        ok = 0
        err = repr(e)
    finally:
        try:
            r.close()
        except Exception:
            pass

    with _lock:
        event_items = list(_event_totals.items())
        fail_items = list(_fail_totals.items())
        host_items = list(_host_event_totals.items())
        delayed_hosts = {q: dict(v) for q, v in _delayed_by_host.items()}
        process_counts = {
            q: sum(1 for t in _active_times[q] if t >= time.time() - PROCESS_WINDOW_SEC)
            for q in QUEUES
        }
        stream_ok = _stream_ok
        stream_err = _stream_error
        delayed_ok = _delayed_scan_ok
        delayed_err = _delayed_scan_error
        delayed_age = (time.time() - _delayed_scan_at) if _delayed_scan_at else -1

    lines += [
        "# HELP misskey_queue_events_total BullMQ queue events observed since exporter start",
        "# TYPE misskey_queue_events_total counter",
    ]
    for (queue, event), n in sorted(event_items):
        lines.append(f'misskey_queue_events_total{{queue="{queue}",event="{event}"}} {n}')

    lines += [
        "# HELP misskey_queue_process Active-start count in the last window (Misskey admin Process)",
        "# TYPE misskey_queue_process gauge",
    ]
    for q, n in process_counts.items():
        lines.append(f'misskey_queue_process{{queue="{q}"}} {n}')

    lines += [
        "# HELP misskey_queue_fail_total Failed jobs by normalized reason since exporter start",
        "# TYPE misskey_queue_fail_total counter",
    ]
    for (queue, reason), n in sorted(fail_items):
        safe = reason.replace("\\", "\\\\").replace('"', '\\"')
        lines.append(f'misskey_queue_fail_total{{queue="{queue}",reason="{safe}"}} {n}')

    lines += [
        "# HELP misskey_queue_host_events_total Queue events by destination host",
        "# TYPE misskey_queue_host_events_total counter",
    ]
    for (queue, host, event), n in sorted(host_items):
        lines.append(
            f'misskey_queue_host_events_total{{queue="{queue}",host="{host}",event="{event}"}} {n}'
        )

    lines += [
        "# HELP misskey_queue_delayed_total Delayed jobs currently waiting (full count)",
        "# TYPE misskey_queue_delayed_total gauge",
        "# HELP misskey_queue_delayed_by_host Delayed jobs currently waiting, by job name/host (top N)",
        "# TYPE misskey_queue_delayed_by_host gauge",
    ]
    for queue, hosts in delayed_hosts.items():
        hosts = dict(hosts)
        total = hosts.pop("__total__", None)
        if total is not None:
            lines.append(f'misskey_queue_delayed_total{{queue="{queue}"}} {total}')
        for host, n in hosts.items():
            lines.append(
                f'misskey_queue_delayed_by_host{{queue="{queue}",host="{host}"}} {n}'
            )

    lines += [
        "# HELP misskey_nodejs_rss_bytes Resident set size of Misskey node processes",
        "# TYPE misskey_nodejs_rss_bytes gauge",
        "# HELP misskey_nodejs_anon_bytes Anonymous memory (smaps); proxy for V8 heap growth",
        "# TYPE misskey_nodejs_anon_bytes gauge",
        "# HELP misskey_nodejs_uptime_seconds Process uptime from /proc",
        "# TYPE misskey_nodejs_uptime_seconds gauge",
        "# HELP misskey_nodejs_process_up 1 if role process is visible",
        "# TYPE misskey_nodejs_process_up gauge",
    ]
    seen = {"worker": 0, "master": 0}
    btime = read_btime()
    hz = read_hz()
    now = time.time()
    for role, pid in discover_misskey_procs():
        seen[role] = 1
        rss_kb = read_status_kb(pid, "VmRSS")
        if rss_kb is not None:
            lines.append(f'misskey_nodejs_rss_bytes{{role="{role}"}} {rss_kb * 1024}')
        anon_kb = read_smaps_anon_kb(pid)
        if anon_kb is not None:
            lines.append(f'misskey_nodejs_anon_bytes{{role="{role}"}} {anon_kb * 1024}')
        start_ticks = read_starttime_ticks(pid)
        if btime is not None and start_ticks is not None and hz > 0:
            uptime = max(0.0, now - (btime + start_ticks / hz))
            lines.append(f'misskey_nodejs_uptime_seconds{{role="{role}"}} {uptime:.3f}')
    for role, up in seen.items():
        lines.append(f'misskey_nodejs_process_up{{role="{role}"}} {up}')

    # growth helper: anon per hour of uptime (instantaneous level / uptime)
    lines += [
        "# HELP misskey_nodejs_anon_per_uptime_bytes Anon bytes / uptime seconds (rough growth intensity)",
        "# TYPE misskey_nodejs_anon_per_uptime_bytes gauge",
    ]
    for role, pid in discover_misskey_procs():
        anon_kb = read_smaps_anon_kb(pid)
        start_ticks = read_starttime_ticks(pid)
        if anon_kb is None or btime is None or start_ticks is None:
            continue
        uptime = max(1.0, now - (btime + start_ticks / hz))
        lines.append(
            f'misskey_nodejs_anon_per_uptime_bytes{{role="{role}"}} {(anon_kb * 1024) / uptime:.3f}'
        )

    lines += [
        "# HELP misskey_queue_exporter_up 1 if Redis depth scrape succeeded",
        "# TYPE misskey_queue_exporter_up gauge",
        f"misskey_queue_exporter_up {ok}",
        "# HELP misskey_queue_stream_up 1 if event stream consumer is healthy",
        "# TYPE misskey_queue_stream_up gauge",
        f"misskey_queue_stream_up {stream_ok}",
        "# HELP misskey_queue_delayed_scan_up 1 if delayed-by-host scanner is healthy",
        "# TYPE misskey_queue_delayed_scan_up gauge",
        f"misskey_queue_delayed_scan_up {delayed_ok}",
        "# HELP misskey_queue_delayed_scan_age_seconds Age of last delayed-host scan",
        "# TYPE misskey_queue_delayed_scan_age_seconds gauge",
        f"misskey_queue_delayed_scan_age_seconds {delayed_age}",
        "# HELP misskey_queue_exporter_scrape_seconds Scrape duration",
        "# TYPE misskey_queue_exporter_scrape_seconds gauge",
        f"misskey_queue_exporter_scrape_seconds {time.time() - started:.6f}",
    ]
    if err:
        lines.append(f"# depth_error {err}")
    if stream_err:
        lines.append(f"# stream_error {stream_err}")
    if delayed_err:
        lines.append(f"# delayed_scan_error {delayed_err}")
    return "\n".join(lines) + "\n"


class Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt: str, *args) -> None:
        return

    def do_GET(self) -> None:
        if self.path.split("?")[0] not in ("/metrics", "/"):
            self.send_response(404)
            self.end_headers()
            return
        data = collect_metrics().encode()
        self.send_response(200)
        self.send_header("Content-Type", "text/plain; version=0.0.4; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)


def main() -> None:
    threading.Thread(target=stream_worker, name="bullmq-stream", daemon=True).start()
    threading.Thread(target=delayed_host_scanner, name="delayed-hosts", daemon=True).start()
    server = ThreadingHTTPServer((BIND, PORT), Handler)
    print(
        f"misskey-queue-exporter on {BIND}:{PORT} prefix={QUEUE_PREFIX} queues={QUEUES}",
        flush=True,
    )
    server.serve_forever()


if __name__ == "__main__":
    main()
