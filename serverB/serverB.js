
const express = require("express");
const os = require("os");
require('dotenv').config({ path: process.env.DOTENV_PATH || '.env.serverB' });



const app = express();

const PORT = parseInt(process.env.PORT || "3000", 10);

// ---- Gilbert-Elliott parameters (bursty loss model) ----
// You can override via env vars when launching each instance
let GE_state = "G"; // 'G' = good, 'B' = bad
const P_G_TO_B   = parseFloat(process.env.P_G_TO_B   || 0.03); // prob G->B
const P_B_TO_G   = parseFloat(process.env.P_B_TO_G   || 0.08); // prob B->G
const LOSS_IN_G  = parseFloat(process.env.LOSS_IN_G  || 0.01); // loss prob in Good
const LOSS_IN_B  = parseFloat(process.env.LOSS_IN_B  || 0.45); // loss prob in Bad

// ---- Load / queue simulation ----
let queueLen = 0;
const SIM_QUEUE_MAX = parseInt(process.env.SIM_QUEUE_MAX || "80", 10);

// jitter queue length to simulate changing load
setInterval(() => {
  if (Math.random() < 0.6 && queueLen < SIM_QUEUE_MAX) queueLen += Math.floor(Math.random() * 3);
  else queueLen = Math.max(0, queueLen - Math.floor(Math.random() * 2));
}, 200);

// ---- Slow/error probabilities and CPU work ----
const ERR_RATE   = parseFloat(process.env.ERR_RATE   || 0.03); // 5xx probability
const SLOW_RATE  = parseFloat(process.env.SLOW_RATE  || 0.08); // slow response probability
const SLOW_MS    = parseInt(process.env.SLOW_MS || "600", 10); // slow response time (ms)
const CPU_LOAD_MS = parseInt(process.env.CPU_LOAD_MS || "0", 10); // busy-spin ms per request
const OVERLOAD_DROP_MULTIPLIER = parseFloat(process.env.OVERLOAD_DROP_MULTIPLIER || 0.6); // scale overload drop

// simple busy-spin to simulate CPU work (small, do not use heavy values on your laptop)
function simulateCpuWork(ms) {
  if (!ms || ms <= 0) return;
  const start = Date.now();
  while (Date.now() - start < ms) {
    // trivial computation to keep CPU busy for ms milliseconds
    Math.sqrt(12345);
  }
}

// Gilbert-Elliott state transition + drop decision
function geShouldDrop() {
  // state transition
  const p = Math.random();
  if (GE_state === "G") {
    if (p < P_G_TO_B) GE_state = "B";
  } else {
    if (p < P_B_TO_G) GE_state = "G";
  }
  const lossProb = (GE_state === "G") ? LOSS_IN_G : LOSS_IN_B;
  return Math.random() < lossProb;
}

// root
app.get("/", (req, res) => {
  res.send(`Hello from backend on port ${PORT}`);
});

// health endpoint with combined failure modes
app.get("/health", (req, res) => {
  // overload probability (0..1) derived from queueLen
  const overloadProb = Math.tanh(Math.max(0, (queueLen - 8) / 20)); // smooth mapping

  // Combined drop decision: Gilbert-Elliott burst OR overload-induced
  if (geShouldDrop() || Math.random() < overloadProb * OVERLOAD_DROP_MULTIPLIER) {
    // Simulate a dropped packet: no response (proxy will timeout)
    // Optional debug: console.log(`[HEALTH:${PORT}] DROP (GE=${GE_state} queue=${queueLen})`);
    return;
  }

  // occasional server error
  if (Math.random() < ERR_RATE) {
    // small chance of 500 error
    return res.status(500).send("Simulated 500");
  }

  // occasional slow response path
  if (Math.random() < SLOW_RATE) {
    simulateCpuWork(CPU_LOAD_MS);
    return setTimeout(() => res.send("OK (slow)"), SLOW_MS);
  }

  // normal fast response
  simulateCpuWork(CPU_LOAD_MS);
  res.send("OK");
});

// metrics endpoint: expose internal state for proxy to poll
app.get("/metrics", (req, res) => {
  const mem = process.memoryUsage();
  res.json({
    port: PORT,
    ge_state: GE_state,
    queueLen,
    simQueueMax: SIM_QUEUE_MAX,
    cpuBusyMs: CPU_LOAD_MS,
    slowRate: SLOW_RATE,
    slowMs: SLOW_MS,
    errRate: ERR_RATE,
    lossParams: { P_G_TO_B, P_B_TO_G, LOSS_IN_G, LOSS_IN_B },
    memRss: mem.rss,
    heapUsed: mem.heapUsed,
    uptime: process.uptime(),
    timestamp: Date.now()
  });
});

app.listen(PORT, () => {
  console.log(`Backend B instance running on http://localhost:${PORT}`);
  console.log("Params:", {
    PORT,
    P_G_TO_B, P_B_TO_G, LOSS_IN_G, LOSS_IN_B,
    SIM_QUEUE_MAX, ERR_RATE, SLOW_RATE, SLOW_MS, CPU_LOAD_MS
  });
});
