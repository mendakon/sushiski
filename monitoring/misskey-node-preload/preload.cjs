'use strict';
/**
 * Non-invasive Misskey Node metrics preload.
 * Enabled via NODE_OPTIONS=--require /misskey/monitoring-preload.cjs
 * Serves Prometheus metrics on 0.0.0.0:9102 (worker) / :9103 (master) once process.title is set.
 */
const http = require('node:http');
const { monitorEventLoopDelay, PerformanceObserver } = require('node:perf_hooks');

const WORKER_PORT = Number(process.env.MISSKEY_METRICS_WORKER_PORT || 9102);
const MASTER_PORT = Number(process.env.MISSKEY_METRICS_MASTER_PORT || 9103);
const BIND = process.env.MISSKEY_METRICS_BIND || '0.0.0.0';

let role = null;
let server = null;
let eld = null;
let lastCpu = process.cpuUsage();
let lastCpuAt = Date.now();

const gc = {
	count: 0,
	durationSeconds: 0,
	byKind: Object.create(null),
};

try {
	const obs = new PerformanceObserver((list) => {
		for (const entry of list.getEntries()) {
			gc.count += 1;
			gc.durationSeconds += entry.duration / 1000;
			const kind = String(entry.kind ?? entry.detail?.kind ?? 'unknown');
			gc.byKind[kind] = (gc.byKind[kind] || 0) + 1;
		}
	});
	obs.observe({ entryTypes: ['gc'], buffered: false });
} catch (e) {
	// older node / restricted env
	console.error('[monitoring-preload] GC observer unavailable:', e.message);
}

function detectRole() {
	const t = process.title || '';
	if (t.includes('Misskey (worker)')) return 'worker';
	if (t.includes('Misskey (master)')) return 'master';
	return null;
}

function metricsBody() {
	const mem = process.memoryUsage();
	const now = Date.now();
	const cpu = process.cpuUsage(lastCpu);
	const wall = Math.max(0.001, (now - lastCpuAt) / 1000);
	lastCpu = process.cpuUsage();
	lastCpuAt = now;
	const userRatio = cpu.user / 1e6 / wall;
	const systemRatio = cpu.system / 1e6 / wall;

	const lines = [];
	const r = role || 'unknown';

	lines.push('# HELP misskey_v8_heap_used_bytes V8 heap used');
	lines.push('# TYPE misskey_v8_heap_used_bytes gauge');
	lines.push(`misskey_v8_heap_used_bytes{role="${r}"} ${mem.heapUsed}`);

	lines.push('# HELP misskey_v8_heap_total_bytes V8 heap total');
	lines.push('# TYPE misskey_v8_heap_total_bytes gauge');
	lines.push(`misskey_v8_heap_total_bytes{role="${r}"} ${mem.heapTotal}`);

	lines.push('# HELP misskey_v8_external_bytes C++ objects bound to JS');
	lines.push('# TYPE misskey_v8_external_bytes gauge');
	lines.push(`misskey_v8_external_bytes{role="${r}"} ${mem.external}`);

	lines.push('# HELP misskey_v8_array_buffers_bytes ArrayBuffers / SharedArrayBuffers');
	lines.push('# TYPE misskey_v8_array_buffers_bytes gauge');
	lines.push(`misskey_v8_array_buffers_bytes{role="${r}"} ${mem.arrayBuffers}`);

	lines.push('# HELP misskey_nodejs_process_rss_bytes process.memoryUsage().rss');
	lines.push('# TYPE misskey_nodejs_process_rss_bytes gauge');
	lines.push(`misskey_nodejs_process_rss_bytes{role="${r}"} ${mem.rss}`);

	lines.push('# HELP misskey_nodejs_uptime_seconds Process uptime');
	lines.push('# TYPE misskey_nodejs_uptime_seconds gauge');
	lines.push(`misskey_nodejs_uptime_seconds{role="${r}"} ${process.uptime()}`);

	if (eld) {
		lines.push('# HELP misskey_event_loop_lag_seconds Event loop delay (monitorEventLoopDelay)');
		lines.push('# TYPE misskey_event_loop_lag_seconds gauge');
		lines.push(`misskey_event_loop_lag_seconds{role="${r}",stat="min"} ${eld.min / 1e9}`);
		lines.push(`misskey_event_loop_lag_seconds{role="${r}",stat="mean"} ${eld.mean / 1e9}`);
		lines.push(`misskey_event_loop_lag_seconds{role="${r}",stat="p50"} ${eld.percentile(50) / 1e9}`);
		lines.push(`misskey_event_loop_lag_seconds{role="${r}",stat="p99"} ${eld.percentile(99) / 1e9}`);
		lines.push(`misskey_event_loop_lag_seconds{role="${r}",stat="max"} ${eld.max / 1e9}`);
		eld.reset();
	}

	lines.push('# HELP misskey_gc_count_total GC invocations since process start');
	lines.push('# TYPE misskey_gc_count_total counter');
	lines.push(`misskey_gc_count_total{role="${r}",kind="all"} ${gc.count}`);
	for (const [kind, n] of Object.entries(gc.byKind)) {
		lines.push(`misskey_gc_count_total{role="${r}",kind="${kind}"} ${n}`);
	}

	lines.push('# HELP misskey_gc_duration_seconds_total GC duration seconds since process start');
	lines.push('# TYPE misskey_gc_duration_seconds_total counter');
	lines.push(`misskey_gc_duration_seconds_total{role="${r}"} ${gc.durationSeconds}`);

	lines.push('# HELP misskey_process_cpu_ratio CPU time / wall time since last scrape (~1 if busy)');
	lines.push('# TYPE misskey_process_cpu_ratio gauge');
	lines.push(`misskey_process_cpu_ratio{role="${r}",mode="user"} ${userRatio}`);
	lines.push(`misskey_process_cpu_ratio{role="${r}",mode="system"} ${systemRatio}`);

	lines.push('# HELP misskey_node_metrics_up 1 if preload metrics server is running');
	lines.push('# TYPE misskey_node_metrics_up gauge');
	lines.push(`misskey_node_metrics_up{role="${r}"} 1`);

	return lines.join('\n') + '\n';
}

function startServer(detected) {
	role = detected;
	const port = role === 'worker' ? WORKER_PORT : MASTER_PORT;
	try {
		eld = monitorEventLoopDelay({ resolution: 20 });
		eld.enable();
	} catch (e) {
		console.error('[monitoring-preload] event loop delay unavailable:', e.message);
	}

	server = http.createServer((req, res) => {
		if (req.url !== '/metrics' && req.url !== '/') {
			res.writeHead(404);
			res.end();
			return;
		}
		const body = metricsBody();
		res.writeHead(200, {
			'Content-Type': 'text/plain; version=0.0.4; charset=utf-8',
			'Content-Length': Buffer.byteLength(body),
		});
		res.end(body);
	});
	server.listen(port, BIND, () => {
		console.log(`[monitoring-preload] ${role} metrics on ${BIND}:${port}`);
	});
	server.on('error', (e) => {
		console.error('[monitoring-preload] listen error:', e.message);
	});
}

const timer = setInterval(() => {
	if (server) return;
	const detected = detectRole();
	if (detected) {
		clearInterval(timer);
		startServer(detected);
	}
}, 1000);

// Do not keep process alive solely because of this timer before role detect in weird cases
timer.unref?.();
