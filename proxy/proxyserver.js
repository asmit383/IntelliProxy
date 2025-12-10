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
    lossPercent: 0,
    totalPings: 0,
    totalRequests: 0,
    errorRequests: 0,
    errorRate: 0,
    activeRequests: 0,
  },
];

function pingServer(server) {
  const start = Date.now();
  const req = http.get(server.url + "/health", (res) => {
    
    res.on("data", () => {});
    res.on("end", () => {
      const ms = Date.now() - start;
      server.latency = ms;

      server.successPings += 1;
      const totalPings = server.successPings + server.failPings;
      server.totalPings = totalPings;

      server.lossPercent =
        totalPings === 0 ? 0 : (server.failPings / totalPings) * 100;

      console.log(
        `Ping ${server.name}: ${ms} ms | loss=${server.lossPercent.toFixed(2)}%`
      );
    });
  });

  req.on("error", (err) => {
    console.log(`Ping ${server.name}: DOWN (${err.message})`);
    server.latency = Infinity;

    server.failPings += 1;
    const totalPings = server.successPings + server.failPings;
    server.totalPings = totalPings;

    server.lossPercent =
      totalPings === 0 ? 0 : (server.failPings / totalPings) * 100;
  });

  req.setTimeout(1000, () => {
    console.log(`Ping ${server.name}: TIMEOUT`);
    server.latency = Infinity;

    server.failPings += 1;
    const totalPings = server.successPings + server.failPings;
    server.totalPings = totalPings;

    server.lossPercent =
      totalPings === 0 ? 0 : (server.failPings / totalPings) * 100;

    req.abort();
  });
}

// 🔁 actually start measuring!
BACKENDS.forEach(pingServer);
setInterval(() => BACKENDS.forEach(pingServer), 5000);

function computeScore(server) {
  const wLatency = 1;   // 1 ms = 1 point
  const wLoss    = 20;  // 1% loss = 20 points
  const wError   = 50;  // 1% errorRate = 50 points
  const wLoad    = 2;   // each active request adds 2

  const latencyPart = Number.isFinite(server.latency) ? server.latency : 10000;
  const lossPercent = Number.isFinite(server.lossPercent)
    ? server.lossPercent
    : 100;
  const errorRate = Number.isFinite(server.errorRate) ? server.errorRate : 1;

  return (
    wLatency * latencyPart +
    wLoss * lossPercent +
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
