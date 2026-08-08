#!/bin/bash
set -euo pipefail
LOG=/home/misskey/sushiski/files/_heap_snapshots/snap2-wait.log
exec > >(tee -a "$LOG") 2>&1
echo "=== snap2 waiter start $(date -Is) ==="

get_ab() {
  sudo -n docker run --rm --network container:sushiski-web curlimages/curl -s http://127.0.0.1:9102/metrics \
    | awk '/^misskey_v8_array_buffers_bytes.role="worker"/{ print $2; exit }'
}
get_rss() {
  sudo -n docker run --rm --network container:sushiski-web curlimages/curl -s http://127.0.0.1:9102/metrics \
    | awk '/^misskey_nodejs_process_rss_bytes.role="worker"/{ print $2; exit }'
}
get_up() {
  sudo -n docker run --rm --network container:sushiski-web curlimages/curl -s http://127.0.0.1:9102/metrics \
    | awk '/^misskey_nodejs_uptime_seconds.role="worker"/{ print $2; exit }'
}

ensure_inspect() {
  local code
  code=$(sudo -n docker run --rm --network container:sushiski-web curlimages/curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:9229/json/list || echo 000)
  if [ "$code" != "200" ]; then
    echo "re-enable inspector"
    sudo -n docker exec -u 0 sushiski-web node -e '
      const fs=require("fs");
      for (const d of fs.readdirSync("/proc")) {
        if (!/^\d+$/.test(d)) continue;
        try {
          const cmd=fs.readFileSync("/proc/"+d+"/cmdline","utf8");
          if (cmd.includes("Misskey (worker)")) { process.kill(Number(d),"SIGUSR1"); console.log("signaled",d); }
        } catch(e) {}
      }'
    sleep 1
  fi
}

preflight() {
  echo "=== preflight $(date -Is) ==="
  local ab rss up avail_kb swap_free health
  ab=$(get_ab); rss=$(get_rss); up=$(get_up)
  avail_kb=$(awk '/MemAvailable:/ {print $2}' /proc/meminfo)
  swap_free=$(awk '/SwapFree:/ {print $2}' /proc/meminfo)
  health=$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 https://sushi.ski/healthz || echo 000)

  python3 - <<PY
ab=float("$ab"); rss=float("$rss"); up=float("$up")
avail=float("$avail_kb")*1024; swap_free=float("$swap_free")*1024
health="$health"
print(f"ab={ab/1e6:.1f}MB rss={rss/1e6:.0f}MB uptime_h={up/3600:.2f}")
print(f"MemAvailable={avail/1e9:.2f}GiB SwapFree={swap_free/1e6:.0f}MB healthz={health}")
ok=True
reasons=[]
if avail < 1.2e9:
  ok=False; reasons.append(f"MemAvailable too low ({avail/1e9:.2f}GiB < 1.2)")
if ab > 1.5e9:
  ok=False; reasons.append(f"arrayBuffers too fat ({ab/1e9:.2f}GiB > 1.5)")
if health != "200":
  ok=False; reasons.append(f"healthz={health}")
if up < 600:
  ok=False; reasons.append(f"worker too fresh (uptime {up:.0f}s) — may have just crashed")
print("GO" if ok else "NO-GO: " + "; ".join(reasons))
raise SystemExit(0 if ok else 1)
PY
}

# Preserve original baseline if provided (so restart doesn't reset the +200MB clock)
if [ -n "${AB0_OVERRIDE:-}" ]; then
  AB0=$AB0_OVERRIDE
else
  AB0=$(get_ab)
fi
RSS0=$(get_rss)
echo "start arrayBuffers=$AB0 rss=$RSS0"
TARGET_DELTA=$((200*1024*1024))  # +200MB
MAX_WAIT=$((90*60))  # 90 min
START=$SECONDS
NEAR=$((180*1024*1024))  # announce near-threshold

while true; do
  AB=$(get_ab)
  DELTA=$(python3 -c "print(int(float('$AB')-float('$AB0')))")
  ELAPSED=$((SECONDS-START))
  echo "$(date -Is) ab=$AB delta=$DELTA elapsed=${ELAPSED}s"
  if [ "$DELTA" -ge "$NEAR" ] && [ "$DELTA" -lt "$TARGET_DELTA" ]; then
    echo "NEAR threshold — early preflight"
    preflight || echo "(near preflight soft-fail; will recheck at threshold)"
  fi
  if [ "$DELTA" -ge "$TARGET_DELTA" ] || [ "$ELAPSED" -ge "$MAX_WAIT" ]; then
    echo "threshold reached (delta=$DELTA elapsed=$ELAPSED)"
    break
  fi
  sleep 120
done

# Final gate: only snap if conditions are good; otherwise wait up to +30min
EXTRA=0
while true; do
  if preflight; then
    echo "preflight OK — taking snap2"
    break
  fi
  EXTRA=$((EXTRA+1))
  if [ "$EXTRA" -ge 15 ]; then
    echo "preflight failed too long — ABORT snap2"
    exit 2
  fi
  echo "preflight NO-GO — wait 120s ($EXTRA/15)"
  sleep 120
done

ensure_inspect
OUT=/out/snap2-after-growth-$(date +%Y%m%d-%H%M%S).heapsnapshot
sudo -n docker run --rm \
  --network container:sushiski-web \
  -v /home/misskey/sushiski/monitoring/heap-tools/take-snapshot.mjs:/take-snapshot.mjs:ro \
  -v /home/misskey/sushiski/files/_heap_snapshots:/out \
  node:26-bookworm-slim \
  node /take-snapshot.mjs "$OUT"
ls -lh /home/misskey/sushiski/files/_heap_snapshots/
echo "=== snap2 waiter done $(date -Is) ==="
