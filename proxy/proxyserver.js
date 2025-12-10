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
    successPings: 0,
    failPings: 0,
    latencyEwma: undefined,   // optional
    lossEwma: 0,              // start at 0 (healthy)
    lossPercent: 0,
    totalPings: 0,
    totalRequests: 0,
    errorRequests: 0,
    errorRate: 0,
    activeRequests: 0,
  },
  {
    name: "B",
    url: "http://localhost:3002",
    latency: Infinity,
    successPings: 0,
    failPings: 0,
    latencyEwma: undefined,   // optional
    lossEwma: 0,              // start at 0 (healthy)
    lossPercent: 0,
    totalPings: 0,
    totalRequests: 0,
    errorRequests: 0,
    errorRate: 0,
    activeRequests: 0,
  },
];
function ewma(old, value, alpha = 0.2) {
  if (!Number.isFinite(old)) return value;
  return alpha * value + (1 - alpha) * old;
}
function pingServer(server) {
  const start = Date.now();

  const req = http.get(server.url + "/health", (res) => {
    res.on("data", () => {}); // consume body
    res.on("end", () => {
      const ms = Date.now() - start;

      // raw/latest latency
      server.latency = ms;

      // update smoothed latency (EWMA, in ms)
      server.latencyEwma = ewma(server.latencyEwma, ms, 0.2);

      // success bookkeeping
      server.successPings += 1;
      server.totalPings = server.successPings + server.failPings;

      // success sample = 0 (no loss)
      server.lossEwma = ewma(server.lossEwma, 0, 0.2);

      // expose lossPercent for compatibility (0..100)
      server.lossPercent = Number.isFinite(server.lossEwma)
        ? server.lossEwma * 100
        : 0;

      console.log(
        `Ping ${server.name}: ${ms} ms | loss=${server.lossPercent.toFixed(2)}% | latEwma=${(server.latencyEwma||ms).toFixed(1)}ms`
      );
    });
  });

  req.on("error", (err) => {
    console.log(`Ping ${server.name}: DOWN (${err.message})`);

    // treat as failure
    server.latency = Infinity;

    server.failPings += 1;
    server.totalPings = server.successPings + server.failPings;

    // failure sample = 1 (full loss)
    server.lossEwma = ewma(server.lossEwma, 1, 0.2);

    // reflect EWMA as percent
    server.lossPercent = Number.isFinite(server.lossEwma)
      ? server.lossEwma * 100
      : 100;
  });

  // timeout handling (tune ms as you like)
  req.setTimeout(1000, () => {
    console.log(`Ping ${server.name}: TIMEOUT`);

    server.latency = Infinity;

    server.failPings += 1;
    server.totalPings = server.successPings + server.failPings;

    // timeout counts as failure in EWMA
    server.lossEwma = ewma(server.lossEwma, 1, 0.2);

    server.lossPercent = Number.isFinite(server.lossEwma)
      ? server.lossEwma * 100
      : 100;

    req.abort();
  });
}


// 🔁 actually start measuring!
BACKENDS.forEach(pingServer);
setInterval(() => BACKENDS.forEach(pingServer), 5000);

function computeScore(server) {
  const wLatency = 1;   // tune as needed
  const wLoss    = 200; // lossEwma is 0..1, so weight accordingly
  const wError   = 50;
  const wLoad    = 2;

  // prefer smoothed latency if available
  const latencyPart = Number.isFinite(server.latencyEwma)
    ? server.latencyEwma
    : (Number.isFinite(server.latency) ? server.latency : 10000);

  const lossEwma = Number.isFinite(server.lossEwma) ? server.lossEwma : 0;
  const errorRate = Number.isFinite(server.errorRate) ? server.errorRate : 0;

  // lossEwma is 0..1; scale with wLoss and optionally cap
  const lossContribution = wLoss * Math.min(lossEwma, 0.95); 

  return (
    wLatency * latencyPart +
    lossContribution +
    wError * (errorRate * 100) +
    wLoad * server.activeRequests
  );
}


function getBestBackend() {
  const alive = BACKENDS.filter((s) => Number.isFinite(s.latency));
  const pool = alive.length > 0 ? alive : BACKENDS;

  let best = pool[0];
  let bestScore = computeScore(best);

  for (const s of pool.slice(1)) {
    const sScore = computeScore(s);
    if (sScore < bestScore) {
      best = s;
      bestScore = sScore;
    }
  }

  console.log(
    `Chosen backend: ${best.name} (${best.url}) | ` +
      `lat=${best.latency}ms, loss=${best.lossPercent.toFixed(
        2
      )}%, errRate=${(best.errorRate * 100).toFixed(2)}%, ` +
      `active=${best.activeRequests}, score=${bestScore.toFixed(2)}`
  );

  return best;
}

app.get("/stats", (req, res) => {
  res.json(
    BACKENDS.map((b) => ({
      name: b.name,
      url: b.url,
      latency: b.latency,
      lossPercent: b.lossPercent,
      successPings: b.successPings,
      failPings: b.failPings,
      totalPings: b.totalPings,
      totalRequests: b.totalRequests,
      errorRequests: b.errorRequests,
      errorRate: b.errorRate,
      activeRequests: b.activeRequests,
      alive: Number.isFinite(b.latency),
      score: computeScore(b),
    }))
  );
});

app.use("/", (req, res, next) => {
  const best = getBestBackend();
  const target = best.url;

  best.activeRequests += 1;
  best.totalRequests += 1;

  console.log(`Routing to: ${best.name} (${target})`);

  const proxy = createProxyMiddleware({
    target,
    changeOrigin: true,
    selfHandleResponse: false,
  });

  res.on("finish", () => {
    best.activeRequests -= 1;

    if (res.statusCode >= 500) {
      best.errorRequests += 1;
    }

    best.errorRate = best.errorRequests / best.totalRequests;
  });

  res.on("close", () => {
    if (best.activeRequests > 0) {
      best.activeRequests -= 1;
    }
  });

  return proxy(req, res, next);
});

app.listen(PORT, () => {
  console.log(`IntelliProxy running at http://localhost:${PORT}`);
});
