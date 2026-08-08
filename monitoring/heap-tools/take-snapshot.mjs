import fs from 'node:fs';

const snapPath = process.argv[2] || '/out/snap.heapsnapshot';
const list = await fetch('http://127.0.0.1:9229/json/list').then((r) => r.json());
if (!list[0]) throw new Error('no inspect target');
console.log('target', list[0].title, list[0].id);

const ws = new WebSocket(list[0].webSocketDebuggerUrl);
await new Promise((res, rej) => {
  ws.addEventListener('open', res);
  ws.addEventListener('error', rej);
});

let id = 1;
const pending = new Map();
const chunks = [];
let chunkBytes = 0;

ws.addEventListener('message', (ev) => {
  const msg = JSON.parse(typeof ev.data === 'string' ? ev.data : Buffer.from(ev.data).toString());
  if (msg.method === 'HeapProfiler.addHeapSnapshotChunk') {
    const c = msg.params?.chunk || '';
    chunks.push(c);
    chunkBytes += c.length;
    if (chunks.length % 200 === 0) console.log('chunks', chunks.length, 'bytes', chunkBytes);
    return;
  }
  if (msg.method === 'HeapProfiler.reportHeapSnapshotProgress') {
    const p = msg.params || {};
    if (p.finished || (p.total && p.done % 5000 === 0)) {
      console.log('progress', p.done, '/', p.total, 'finished=', p.finished);
    }
    return;
  }
  if (msg.id != null && pending.has(msg.id)) pending.get(msg.id)(msg);
});

const call = (method, params = {}, timeoutMs = 900000) =>
  new Promise((resolve, reject) => {
    const myId = id++;
    const t = setTimeout(() => reject(new Error('timeout ' + method)), timeoutMs);
    pending.set(myId, (msg) => {
      clearTimeout(t);
      resolve(msg);
    });
    ws.send(JSON.stringify({ id: myId, method, params }));
  });

const evalRes = await call('Runtime.evaluate', {
  expression: '({title:process.title, pid:process.pid, mem:process.memoryUsage(), uptime:process.uptime()})',
  returnByValue: true,
});
console.log('evaluate full keys', Object.keys(evalRes));
console.log('evaluate result', JSON.stringify(evalRes.result, null, 2));
console.log('exception', JSON.stringify(evalRes.exceptionDetails || null));

await call('HeapProfiler.enable');
console.log('taking heap snapshot via HeapProfiler...', new Date().toISOString());
const started = Date.now();
const take = await call('HeapProfiler.takeHeapSnapshot', { reportProgress: true });
console.log('take result', JSON.stringify(take));
console.log('elapsed_sec', ((Date.now() - started) / 1000).toFixed(1));
console.log('total chunk bytes', chunkBytes);

fs.writeFileSync(snapPath, chunks.join(''));
console.log('wrote', snapPath, 'size', fs.statSync(snapPath).size);
ws.close();
