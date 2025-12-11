// proxyserver.js
const express = require("express");
const http = require("http");
const { createProxyMiddleware } = require("http-proxy-middleware");

const app = express();
const PORT = 3001;

const BACKENDS = [
  {
    name: "A",
    url: "http://localhost:3000",
    latency: Infinity,
    latencyEwma: undefined,
    successPings: 0,
    failPings: 0,
    lossEwma: 0,
    lossPercent: 0,
    totalPings: 0,
    totalRequests: 0,
    errorRequests: 0,
    errorRate: 0,
    activeRequests: 0,
    // runtime metrics (populated by poller)
    queue: 0,
    queueEwma: undefined,
    cpuBusyMs: 0,
  },
  {
    name: "B",
    url: "http://localhost:3002",
    latency: Infinity,
    latencyEwma: undefined,
    successPings: 0,
    failPings: 0,
    lossEwma: 0,
    lossPercent: 0,
    totalPings: 0,
    totalRequests: 0,
    errorRequests: 0,
    errorRate: 0,
    activeRequests: 0,
    queue: 0,
    queueEwma: undefined,
    cpuBusyMs: 0,
  },
];

// ---- config / thresholds ----
const MIN_PINGS = 5;               // don't trust loss until at least this many pings
const SWITCH_THRESHOLD = 30;       // require new backend to be this many points better
const SWITCH_COOLDOWN_MS = 1500;   // cooldown after switching (ms)
let lastChosenName = null;
let lastSwitchAt = 0;

// ---- EWMA helper ----
function ewma(old, value, alpha = 0.2) {
  if (old === undefined || !Number.isFinite(old)) return value;
  return alpha * value + (1 - alpha) * old;
}

// ---- create a reusable proxy middleware per backend (avoid new instance per request) ----
for (const b of BACKENDS) {
  b.proxy = createProxyMiddleware({
    target: b.url,
    changeOrigin: true,
    selfHandleResponse: false,
    onError(err, req, res) {
      console.error(`Proxy error for ${b.name}:`, err && err.message);
      if (!res.headersSent) res.statusCode = 502;
      try { res.end("Bad gateway"); } catch (e) {}
    }
  });
}

// ---- ping / health checker (with EWMA for latency & loss) ----
function pingServer(server) {
  const start = Date.now();

  const req = http.get(server.url + "/health", (res) => {
    // consume body
    res.on("data", () => {});
    res.on("end", () => {
      const ms = Date.now() - start;

      server.latency = ms;
      server.latencyEwma = ewma(server.latencyEwma, ms, 0.2);

      server.successPings += 1;
      server.totalPings = server.successPings + server.failPings;

      // success => loss sample = 0
      server.lossEwma = ewma(server.lossEwma, 0, 0.2);
      server.lossPercent = Number.isFinite(server.lossEwma) ? server.lossEwma * 100 : 0;

      console.log(
        `Ping ${server.name}: ${ms} ms | loss=${server.lossPercent.toFixed(2)}% | latEwma=${(server.latencyEwma||ms).toFixed(1)}ms`
      );
    });
  });

  req.on("error", (err) => {
    console.log(`Ping ${server.name}: DOWN (${err.message})`);
    server.latency = Infinity;
    server.failPings += 1;
    server.totalPings = server.successPings + server.failPings;
    // failure => loss sample = 1
    server.lossEwma = ewma(server.lossEwma, 1, 0.2);
    server.lossPercent = Number.isFinite(server.lossEwma) ? server.lossEwma * 100 : 100;
  });

  req.setTimeout(1000, () => {
    console.log(`Ping ${server.name}: TIMEOUT`);
    server.latency = Infinity;
    server.failPings += 1;
    server.totalPings = server.successPings + server.failPings;
    server.lossEwma = ewma(server.lossEwma, 1, 0.2);
    server.lossPercent = Number.isFinite(server.lossEwma) ? server.lossEwma * 100 : 100;
    req.abort();
  });
}

// start pinging
BACKENDS.forEach(pingServer);
setInterval(() => BACKENDS.forEach(pingServer), 5000);

// ---- poll backend /metrics endpoint (queue/cpu) ----
function pollMetrics(server) {
  http.get(server.url + "/metrics", (res) => {
    let body = "";
    res.on("data", (c) => (body += c));
    res.on("end", () => {
      try {
        const j = JSON.parse(body);
        const q = Number.isFinite(j.queueLen) ? j.queueLen : server.queue || 0;
        server.queue = q;
        server.cpuBusyMs = j.cpuBusyMs || server.cpuBusyMs || 0;
        server.queueEwma = ewma(server.queueEwma, server.queue, 0.2);
      } catch (e) {
        // ignore parse/other errors
      }
    });
  }).on("error", () => {
    // ignore metric poll errors
  });
}
setInterval(() => BACKENDS.forEach(pollMetrics), 3000);

// ---- scoring: latency (ms), loss (0..1), errorRate (0..1), activeRequests, queue ----
function computeScore(server) {
  const wLatency = 1;   // 1 ms = 1 point
  const wLoss    = 200; // lossEwma in 0..1 (scale appropriately)
  const wError   = 50;
  const wLoad    = 2;   // active requests
  const wQueue   = 30;  // queue pressure

  const latencyPart = Number.isFinite(server.latencyEwma)
    ? server.latencyEwma
    : (Number.isFinite(server.latency) ? server.latency : 10000);

  const lossEwma = Number.isFinite(server.lossEwma) ? server.lossEwma : 0;
  // don't trust loss until we have some pings
  const effectiveLoss = (server.totalPings >= MIN_PINGS) ? lossEwma : 0;

  const lossContribution = wLoss * Math.min(effectiveLoss, 0.95);
  const errorRate = Number.isFinite(server.errorRate) ? server.errorRate : 0;

  const queueNorm = Number.isFinite(server.queueEwma) ? Math.tanh(server.queueEwma / 50) : 0;

  return (
    wLatency * latencyPart +
    lossContribution +
    wError * (errorRate * 100) +
    wLoad * server.activeRequests +
    wQueue * queueNorm
  );
}

// ---- selection with a SWITCH_THRESHOLD and cooldown to prevent thrash ----
function getBestBackend() {
  // consider backend alive if we have a finite latency or ewma
  const alive = BACKENDS.filter((s) =>
    Number.isFinite(s.latency) || Number.isFinite(s.latencyEwma)
  );
  const pool = alive.length > 0 ? alive : BACKENDS;

  let best = pool[0];
  let bestScore = computeScore(best);
  let bestContrib = null;

  for (const s of pool.slice(1)) {
    const sScore = computeScore(s);
    if (sScore < bestScore) {
      // require margin to avoid switching for tiny differences
      if (sScore < bestScore - SWITCH_THRESHOLD) {
        best = s;
        bestScore = sScore;
      }
    }
  }

  // cooldown: prevent switching too frequently
  const now = Date.now();
  if (lastChosenName && best.name !== lastChosenName && now - lastSwitchAt < SWITCH_COOLDOWN_MS) {
    const prev = BACKENDS.find((b) => b.name === lastChosenName);
    if (prev) {
      best = prev;
      bestScore = computeScore(best);
    }
  } else if (best.name !== lastChosenName) {
    lastChosenName = best.name;
    lastSwitchAt = now;
  }

  console.log(
    `Chosen backend: ${best.name} (${best.url}) | ` +
    `lat=${best.latency === Infinity ? "INF" : best.latency + "ms"}, ` +
    `latEwma=${best.latencyEwma ? best.latencyEwma.toFixed(1) + "ms" : "n/a"}, ` +
    `loss=${best.lossPercent.toFixed(2)}%, errRate=${(best.errorRate * 100).toFixed(2)}%, ` +
    `queueEwma=${(best.queueEwma||0).toFixed(2)}, active=${best.activeRequests}, score=${bestScore.toFixed(2)}`
  );

  return best;
}

// ---- stats endpoint ----
app.get("/stats", (req, res) => {
  res.json(
    BACKENDS.map((b) => ({
      name: b.name,
      url: b.url,
      latency: b.latency,
      latencyEwma: b.latencyEwma,
      lossPercent: b.lossPercent,
      lossEwma: b.lossEwma,
      successPings: b.successPings,
      failPings: b.failPings,
      totalPings: b.totalPings,
      totalRequests: b.totalRequests,
      errorRequests: b.errorRequests,
      errorRate: b.errorRate,
      activeRequests: b.activeRequests,
      queue: b.queue,
      queueEwma: b.queueEwma,
      alive: Number.isFinite(b.latency),
      score: computeScore(b),
    }))
  );
});

// ---- routing handler (reuse backend.proxy) ----
app.use("/", (req, res, next) => {
  const best = getBestBackend();
  const target = best.url;

  best.activeRequests += 1;
  best.totalRequests += 1;

  console.log(`Routing to: ${best.name} (${target})`);

  // use pre-created proxy middleware
  const proxy = best.proxy;

  // hook into response finish/error
  res.on("finish", () => {
    best.activeRequests -= 1;

    // treat 5xx as error
    if (res.statusCode >= 500) {
      best.errorRequests += 1;
    }
    best.errorRate = best.errorRequests / best.totalRequests;
  });

  res.on("close", () => {
    if (best.activeRequests > 0) best.activeRequests -= 1;
  });

  return proxy(req, res, next);
});

app.listen(PORT, () => {
  console.log(`IntelliProxy running at http://localhost:${PORT}`);
});
