#!/usr/bin/env python3
# 試験運転: リモートキャッシュを少数件だけ isLink 化する。
# 公式 cleanRemoteFiles は呼ばない。web も再起動しない。
# デフォルトは dry-run。Wasabi 削除と DB 更新は --execute のときだけ。
# S3 / Postgres は接続を再利用し、公式と同じく数件ずつまとめて処理する。

from __future__ import annotations

import argparse
import json
import re
import sys
import time
import uuid
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from pathlib import Path

import boto3
import psycopg2
from botocore.config import Config as BotoConfig
from botocore.exceptions import ClientError
from psycopg2.extras import execute_values

REPO_ROOT = Path(__file__).resolve().parents[1]
DEFAULT_YML = REPO_ROOT / ".config" / "default.yml"
DEFAULT_LOG = REPO_ROOT / ".config" / "pilot-clean-remote-files.jsonl"
DEFAULT_STOP = REPO_ROOT / ".config" / "pilot-clean-remote-files.stop"
DEFAULT_STATE = REPO_ROOT / ".config" / "pilot-clean-remote-files.state"

ID_RE = re.compile(r"^[0-9a-z]+$")
KEY_RE = re.compile(r"^[A-Za-z0-9._/-]+$")
URI_RE = re.compile(r"^https?://")


class Fail(Exception):
    pass


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Pilot: convert a small number of remote cached drive files to isLink.",
    )
    parser.add_argument("--config", default=str(DEFAULT_YML), help="Path to default.yml")
    parser.add_argument("--limit", type=int, default=100, help="Max files to process (default 100)")
    parser.add_argument("--after-id", default="", help="Resume after this drive_file.id")
    parser.add_argument(
        "--batch-size",
        type=int,
        default=8,
        help="Files per Wasabi+DB wave (default 8, same as official job)",
    )
    parser.add_argument(
        "--allow-large",
        action="store_true",
        help="Allow --limit greater than 1000",
    )
    parser.add_argument(
        "--execute",
        action="store_true",
        help="Actually delete Wasabi objects and update DB. Default is dry-run.",
    )
    parser.add_argument(
        "--probe",
        action=argparse.BooleanOptionalAction,
        default=None,
        help="HEAD Wasabi objects (default: on for dry-run, off for --execute)",
    )
    parser.add_argument("--verbose", action="store_true", help="Print every file and key")
    parser.add_argument("--sleep-ms", type=int, default=0, help="Pause between waves")
    parser.add_argument(
        "--log",
        default=str(DEFAULT_LOG),
        help="Append deleted id/keys as JSONL for later verification",
    )
    parser.add_argument(
        "--loop",
        action="store_true",
        help="Keep loading --limit chunks until empty or stop file exists",
    )
    parser.add_argument(
        "--stop-file",
        default=str(DEFAULT_STOP),
        help="If this file exists, finish the current wave and exit",
    )
    parser.add_argument(
        "--state-file",
        default=str(DEFAULT_STATE),
        help="Write last processed id here for resume",
    )
    parser.add_argument(
        "--concurrency",
        type=int,
        default=1,
        help="How many waves to run in parallel (default 1)",
    )
    return parser.parse_args()


def read_db_config(path: Path) -> dict[str, str]:
    text = path.read_text(encoding="utf-8")
    in_db = False
    cfg: dict[str, str] = {}
    for raw in text.splitlines():
        if raw.startswith("db:"):
            in_db = True
            continue
        if not in_db:
            continue
        if raw and not raw.startswith((" ", "\t")):
            break
        stripped = raw.strip()
        if not stripped or stripped.startswith("#"):
            continue
        match = re.match(r"(host|port|db|user|pass):\s*(\S+)", stripped)
        if match:
            cfg[match.group(1)] = match.group(2)
    missing = [key for key in ("host", "port", "db", "user", "pass") if key not in cfg]
    if missing:
        raise Fail(f"{path}: missing db keys: {', '.join(missing)}")
    return cfg


def connect_db(db: dict[str, str]):
    return psycopg2.connect(
        host=db["host"],
        port=db["port"],
        user=db["user"],
        password=db["pass"],
        dbname=db["db"],
        connect_timeout=15,
    )


def load_object_storage(cur) -> dict[str, object]:
    cur.execute(
        """
        SELECT
          "useObjectStorage",
          "objectStorageBucket",
          "objectStoragePrefix",
          "objectStorageEndpoint",
          "objectStorageRegion",
          "objectStoragePort",
          "objectStorageUseSSL",
          "objectStorageS3ForcePathStyle",
          "objectStorageAccessKey",
          "objectStorageSecretKey"
        FROM meta
        LIMIT 1
        """
    )
    row = cur.fetchone()
    if row is None:
        raise Fail("meta row is missing")
    meta = {
        "useObjectStorage": row[0],
        "bucket": row[1],
        "prefix": row[2],
        "endpoint": row[3],
        "region": row[4],
        "port": row[5],
        "useSSL": row[6],
        "forcePathStyle": row[7],
        "accessKey": row[8],
        "secretKey": row[9],
    }
    if not meta["useObjectStorage"]:
        raise Fail("meta.useObjectStorage is false")
    for key in ("bucket", "endpoint", "region", "accessKey", "secretKey"):
        if not meta.get(key):
            raise Fail(f"meta object storage {key} is empty")
    return meta


def s3_client(meta: dict[str, object], concurrency: int = 1):
    scheme = "https" if meta["useSSL"] else "http"
    endpoint = str(meta["endpoint"])
    if meta.get("port"):
        endpoint = f"{endpoint}:{meta['port']}"
    return boto3.client(
        "s3",
        endpoint_url=f"{scheme}://{endpoint}",
        region_name=str(meta["region"]),
        aws_access_key_id=str(meta["accessKey"]),
        aws_secret_access_key=str(meta["secretKey"]),
        config=BotoConfig(
            retries={"max_attempts": 8, "mode": "standard"},
            max_pool_connections=max(10, concurrency * 4),
            s3={"addressing_style": "path" if meta["forcePathStyle"] else "auto"},
        ),
    )


def load_files(cur, after_id: str, limit: int):
    cur.execute(
        """
        SELECT
          id,
          "userHost",
          uri,
          "accessKey",
          "thumbnailAccessKey",
          "webpublicAccessKey",
          ("thumbnailUrl" IS NOT NULL),
          ("webpublicUrl" IS NOT NULL)
        FROM drive_file
        WHERE "userHost" IS NOT NULL
          AND NOT "isLink"
          AND uri IS NOT NULL
          AND NOT "storedInternal"
          AND id > %s
        ORDER BY id ASC
        LIMIT %s
        """,
        (after_id or "", int(limit)),
    )
    rows = cur.fetchall()
    fetched = len(rows)
    last_fetched_id = str(rows[-1][0]) if rows else ""
    files: list[dict[str, object]] = []
    for row in rows:
        item = {
            "id": row[0],
            "userHost": row[1],
            "uri": str(row[2] or "").strip(),
            "accessKey": row[3],
            "thumbnailAccessKey": row[4],
            "webpublicAccessKey": row[5],
            "has_thumb": bool(row[6]),
            "has_web": bool(row[7]),
        }
        try:
            validate_file(item)
        except Fail as exc:
            message = str(exc)
            if "uri is not http(s)" in message:
                print(f"SKIP {message}", flush=True)
                continue
            raise
        files.append(item)
    return files, fetched, last_fetched_id


def validate_file(item: dict[str, object]) -> None:
    file_id = str(item["id"])
    if not ID_RE.match(file_id):
        raise Fail(f"unexpected id: {file_id}")
    uri = str(item["uri"] or "").strip()
    item["uri"] = uri
    if not URI_RE.match(uri):
        raise Fail(f"{file_id}: uri is not http(s)")
    for key_name in ("accessKey", "thumbnailAccessKey", "webpublicAccessKey"):
        value = item[key_name]
        if value is None:
            continue
        if not KEY_RE.match(str(value)):
            raise Fail(f"{file_id}: bad {key_name}")
    if item["accessKey"] is None:
        raise Fail(f"{file_id}: accessKey is empty")


def keys_for_file(item: dict[str, object]) -> list[str]:
    keys = [str(item["accessKey"])]
    if item["has_thumb"] and item["thumbnailAccessKey"]:
        keys.append(str(item["thumbnailAccessKey"]))
    if item["has_web"] and item["webpublicAccessKey"]:
        keys.append(str(item["webpublicAccessKey"]))
    return keys


def chunks(items: list, size: int):
    for index in range(0, len(items), size):
        yield items[index:index + size]


def head_object(s3, bucket: str, key: str) -> str:
    try:
        s3.head_object(Bucket=bucket, Key=key)
        return "exists"
    except ClientError as exc:
        code = str(exc.response.get("Error", {}).get("Code", ""))
        if code in {"404", "NoSuchKey", "NotFound"}:
            return "missing"
        raise Fail(f"head-object {key}: {exc}") from exc


def delete_keys(s3, bucket: str, keys: list[str]) -> None:
    if not keys:
        return
    # S3 DeleteObjects accepts at most 1000 keys.
    for group in chunks(keys, 1000):
        response = s3.delete_objects(
            Bucket=bucket,
            Delete={"Objects": [{"Key": key} for key in group], "Quiet": False},
        )
        errors = response.get("Errors") or []
        if errors:
            detail = "; ".join(
                f"{err.get('Key')}:{err.get('Code')}:{err.get('Message')}" for err in errors
            )
            raise Fail(f"delete-objects failed: {detail}")


def update_files(cur, items: list[dict[str, object]]) -> int:
    rows = [
        (
            str(item["id"]),
            str(item["uri"]),
            str(uuid.uuid4()),
            "thumbnail-" + str(uuid.uuid4()),
            "webpublic-" + str(uuid.uuid4()),
        )
        for item in items
    ]
    execute_values(
        cur,
        """
        UPDATE drive_file AS d
        SET
          "isLink" = TRUE,
          url = v.uri,
          "thumbnailUrl" = NULL,
          "webpublicUrl" = NULL,
          "storedInternal" = FALSE,
          "accessKey" = v.access_key,
          "thumbnailAccessKey" = v.thumb_key,
          "webpublicAccessKey" = v.web_key
        FROM (VALUES %s) AS v(id, uri, access_key, thumb_key, web_key)
        WHERE d.id = v.id
          AND d."userHost" IS NOT NULL
          AND NOT d."isLink"
          AND d.uri IS NOT NULL
          AND NOT d."storedInternal"
        """,
        rows,
    )
    ids = [str(item["id"]) for item in items]
    cur.execute(
        """
        SELECT COUNT(*)
        FROM drive_file
        WHERE id = ANY(%s)
          AND "isLink"
        """,
        (ids,),
    )
    return int(cur.fetchone()[0])


def execute_wave(
    db: dict[str, str],
    s3,
    bucket: str,
    wave: list[dict[str, object]],
    do_execute: bool,
) -> tuple[int, int, str]:
    keys = [key for item in wave for key in keys_for_file(item)]
    if not do_execute:
        return 0, 0, str(wave[-1]["id"])
    delete_keys(s3, bucket, keys)
    with connect_db(db) as conn:
        conn.autocommit = False
        with conn.cursor() as cur:
            changed = update_files(cur, wave)
            if changed != len(wave):
                conn.rollback()
                raise Fail(
                    f"{wave[0]['id']}..{wave[-1]['id']}: "
                    f"UPDATE matched {changed}/{len(wave)} rows"
                )
            conn.commit()
    return len(keys), changed, str(wave[-1]["id"])


def append_log(path: Path, wave: list[dict[str, object]]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    ts = datetime.now(timezone.utc).isoformat()
    with path.open("a", encoding="utf-8") as handle:
        for item in wave:
            handle.write(json.dumps({
                "ts": ts,
                "id": item["id"],
                "keys": keys_for_file(item),
            }, ensure_ascii=False) + "\n")


def write_state(path: Path, last_id: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps({"last_id": last_id}, ensure_ascii=False) + "\n", encoding="utf-8")


def read_state(path: Path) -> str:
    if not path.is_file():
        return ""
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError):
        return ""
    last_id = str(data.get("last_id") or "")
    return last_id if ID_RE.match(last_id) else ""


def log(message: str) -> None:
    print(message, flush=True)


def main() -> int:
    args = parse_args()
    if args.limit <= 0:
        raise Fail("--limit must be > 0")
    if args.batch_size <= 0:
        raise Fail("--batch-size must be > 0")
    if args.concurrency <= 0:
        raise Fail("--concurrency must be > 0")
    if args.limit > 1000 and not args.allow_large:
        raise Fail("--limit > 1000 needs --allow-large")
    if args.after_id and not ID_RE.match(args.after_id):
        raise Fail("bad --after-id")

    probe = args.probe if args.probe is not None else (not args.execute)
    mode = "EXECUTE" if args.execute else "DRY-RUN"
    log_path = Path(args.log)
    stop_path = Path(args.stop_file)
    state_path = Path(args.state_file)
    after_id = args.after_id or read_state(state_path)
    db = read_db_config(Path(args.config))

    with connect_db(db) as conn:
        conn.autocommit = False
        with conn.cursor() as cur:
            meta = load_object_storage(cur)
            conn.commit()

        s3 = s3_client(meta, args.concurrency)
        bucket = str(meta["bucket"])

        log(
            f"mode={mode} loop={args.loop} limit={args.limit} batch_size={args.batch_size} "
            f"concurrency={args.concurrency} after_id={after_id or '(start)'} probe={probe}"
        )
        log(
            "storage="
            f"bucket={meta['bucket']} prefix={meta.get('prefix') or ''} "
            f"endpoint={meta['endpoint']} region={meta['region']} "
            f"ssl={meta['useSSL']} pathStyle={meta['forcePathStyle']}"
        )
        log(f"log={log_path} stop={stop_path} state={state_path}")

        total_updated = 0
        total_deleted = 0
        last_ok = after_id
        cycle = 0

        try:
            while True:
                if stop_path.exists():
                    log(f"stop file present: {stop_path}")
                    break

                with conn.cursor() as cur:
                    files, fetched, last_fetched_id = load_files(cur, last_ok, args.limit)
                    conn.commit()

                cycle += 1
                log(
                    f"cycle={cycle} fetched={fetched} candidates={len(files)} "
                    f"after_id={last_ok or '(start)'}"
                )
                if fetched == 0:
                    log("nothing to do")
                    break
                if not files:
                    last_ok = last_fetched_id
                    write_state(state_path, last_ok)
                    log(f"all skipped, advancing to {last_ok}")
                    if fetched < args.limit:
                        log("last cycle was short, finished")
                        break
                    continue

                wave_list = list(chunks(files, args.batch_size))
                index = 0
                workers = args.concurrency if args.execute and not probe else 1
                while index < len(wave_list):
                    if stop_path.exists():
                        log(f"stop file present after wave, exiting: last_id={last_ok}")
                        log(
                            f"done mode={mode} files={total_updated} "
                            f"deleted_keys={total_deleted} updated={total_updated}"
                        )
                        if last_ok:
                            log(f"last_id={last_ok}")
                            log(f"resume: --after-id {last_ok}")
                        return 0

                    group = wave_list[index:index + workers]
                    if args.verbose or probe:
                        for wave in group:
                            keys = [key for item in wave for key in keys_for_file(item)]
                            if args.verbose:
                                for item in wave:
                                    log(
                                        f"- id={item['id']} host={item['userHost']} "
                                        f"keys={','.join(keys_for_file(item))}"
                                    )
                            if probe:
                                missing = 0
                                for key in keys:
                                    state = head_object(s3, bucket, key)
                                    if args.verbose:
                                        log(f"  head {key} {state}")
                                    if state == "missing":
                                        missing += 1
                                if not args.verbose:
                                    log(
                                        f"wave {wave[0]['id']}..{wave[-1]['id']} "
                                        f"files={len(wave)} keys={len(keys)} missing={missing}"
                                    )

                    if args.execute:
                        with ThreadPoolExecutor(max_workers=len(group)) as pool:
                            futures = [
                                pool.submit(execute_wave, db, s3, bucket, wave, True)
                                for wave in group
                            ]
                            results = [future.result() for future in futures]
                    else:
                        results = [
                            execute_wave(db, s3, bucket, wave, False)
                            for wave in group
                        ]

                    for wave, (deleted, changed, _lid) in zip(group, results):
                        if args.execute:
                            append_log(log_path, wave)
                        total_deleted += deleted
                        total_updated += changed
                        log(
                            f"wave {wave[0]['id']}..{wave[-1]['id']} "
                            f"files={len(wave)} deleted_keys={deleted} updated={changed} "
                            f"total_updated={total_updated}"
                        )
                    last_ok = str(group[-1][-1]["id"])
                    write_state(state_path, last_ok)
                    index += len(group)
                    if args.sleep_ms > 0:
                        time.sleep(args.sleep_ms / 1000)

                if not args.loop:
                    break
                if fetched < args.limit:
                    log("last cycle was short, finished")
                    break
        except Fail as exc:
            print(f"ERROR: {exc}", file=sys.stderr, flush=True)
            log(f"stopped_after_id={last_ok or ''}")
            return 1

    log(f"done mode={mode} files={total_updated} deleted_keys={total_deleted} updated={total_updated}")
    if last_ok:
        log(f"last_id={last_ok}")
        log(f"resume: --after-id {last_ok}")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Fail as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        sys.exit(1)
