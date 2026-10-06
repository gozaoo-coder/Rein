const { spawn } = require('node:child_process');
const WebSocket = require('node:websocket');
const http = require('node:http');
const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const PORT = 19222;
const edge = spawn(EDGE, ['--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${process.env.TEMP}/rein-probe-${Date.now()}`, '--no-first-run', 'about:blank'], { stdio: 'ignore' });
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
(async () => {
  await sleep(2000);
  const list = await fetch(`http://127.0.0.1:${PORT}/json`).then(r => r.json());
  const ws = new WebSocket(list[0].webSocketDebuggerUrl);
  let id = 0; const pending = new Map(); const logs = [];
  ws.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
    if (m.method === 'Runtime.consoleAPICalled') logs.push(m.params.args.map(a => a.value ?? a.description ?? '').join(' ').slice(0, 300));
    if (m.method === 'Runtime.exceptionThrown') logs.push('EXC: ' + (m.params.exceptionDetails.exception?.description ?? m.params.exceptionDetails.text).slice(0, 400));
  });
  const cdp = (method, params = {}) => new Promise((res) => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
  await new Promise(r => ws.addEventListener('open', r));
  await cdp('Runtime.enable'); await cdp('Page.enable');
  await cdp('Page.navigate', { url: 'http://localhost:1420/#/ai' });
  await sleep(9000);
  const r = await cdp('Runtime.evaluate', { expression: 'document.body.innerHTML.length + "|" + location.href + "|" + (document.querySelector(".page-header")?.outerHTML?.slice(0,120) ?? "无页头")', returnByValue: true });
  console.log('页面状态:', r.result.result.value);
  console.log('--- 控制台/异常（前 12 条）---');
  logs.slice(0, 12).forEach(l => console.log(l));
  edge.kill();
  process.exit(0);
})();
