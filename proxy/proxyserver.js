// proxyserver.js
const express = require("express");
const http = require("http");
const { createProxyMiddleware } = require("http-proxy-middleware");
const fs = require('fs');
const path = require('path');

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

// ---- RL Configuration ----
// No static thresholds, the agent learns policy.


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
      try { res.end("Bad gateway"); } catch (e) { }
    }
  });
}

// ---- ping / health checker (with EWMA for latency & loss) ----
function pingServer(server) {
  const start = Date.now();

  const req = http.get(server.url + "/health", (res) => {
    // consume body
    res.on("data", () => { });
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
        `Ping ${server.name}: ${ms} ms | loss=${server.lossPercent.toFixed(2)}% | latEwma=${(server.latencyEwma || ms).toFixed(1)}ms`
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

function normalize01(x, div) {
  if (!Number.isFinite(x) || div <= 0) return 0;
  return Math.tanh(Math.max(0, x / div)); // maps 0..inf -> 0..1 smoothly
}

// ---- RL Agent ----
class RLAgent {
  constructor() {
    this.learningRate = 0.1;
    this.epsilon = 0.2; // 20% exploration chance

    // Weights (Linear Q-Function). 
    // We want to MAXIMIZE Reward. 
    // Features like latency/error/load are "costs", so we expect negative weights.
    this.weights = {
      latency: -1.0,
      loss: -5.0,
      error: -20.0,
      load: -1.0,
      queue: -2.0,
      cpu: -1.0,
      memory: -1.0,
      bias: 0.1
    };
  }

  getFeatures(server) {
    const lat = server.latencyEwma || server.latency || 1000; // ms

    // Normalize features to roughly 0..1 range
    const f = {
      latency: Math.tanh(lat / 500),
      loss: (server.lossPercent || 0) / 100,
      error: server.errorRate || 0,
      load: Math.tanh((server.activeRequests || 0) / 10),
      queue: Math.tanh((server.queueEwma || 0) / 20),
      cpu: normalize01(server.cpuBusyMs || 0, 100),
      memory: normalize01(server.heapUsed || server.memRss || 0, 200 * 1024 * 1024),
      bias: 1
    };
    return f;
  }

  predict(server) {
    const f = this.getFeatures(server);
    let q = 0;
    for (const k in this.weights) {
      if (f[k] !== undefined) q += this.weights[k] * f[k];
    }
    return q;
  }

  choose(backends) {
    // 1. Explore
    if (Math.random() < this.epsilon) {
      const alive = backends.filter(b => Number.isFinite(b.latency));
      const pool = alive.length > 0 ? alive : backends;
      const choice = pool[Math.floor(Math.random() * pool.length)];
      console.log(`[RL] Exploring: Selected ${choice.name}`);
      return choice;
    }

    // 2. Exploit
    let best = backends[0];
    let maxQ = -Infinity;

    for (const b of backends) {
      const q = this.predict(b);
      // If q is higher, pick it
      if (q > maxQ) {
        maxQ = q;
        best = b;
      }
    }

    const f = this.getFeatures(best);
    console.log(`[RL] Exploit: Selected ${best.name} (Q=${maxQ.toFixed(2)}). Features:`, JSON.stringify(f));
    return best;
  }

  update(server, durationMs, isError) {
    // Reward Calculation
    // Base = 10. Subtract latency (penalty). Big penalty for error.
    let reward = 10 - (durationMs / 100);
    if (isError) reward -= 50;

    const f = this.getFeatures(server);
    const predicted = this.predict(server);
    const error = reward - predicted;

    // Gradient Descent Step
    for (const k in this.weights) {
      if (f[k] !== undefined) {
        this.weights[k] += this.learningRate * error * f[k];
      }
    }

    console.log(`[RL] Update: ${server.name} | R=${reward.toFixed(1)} | Pred=${predicted.toFixed(1)} | Weights Updated (Lat=${this.weights.latency.toFixed(2)})`);
  }

  savePolicy() {
    try {
      const filePath = path.join(__dirname, 'policy.json');
      const data = JSON.stringify(this.weights, null, 2);
      fs.writeFileSync(filePath, data);
      // console.log('[RL] Policy saved to policy.json'); // Optional logging
    } catch (err) {
      console.error('[RL] Failed to save policy:', err);
    }
  }
}

const agent = new RLAgent();
// Update policy file every 5 seconds
setInterval(() => agent.savePolicy(), 5000);

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
      score: agent.predict(b),
    }))
  );
});

// ---- routing handler (reuse backend.proxy) ----
app.use("/", (req, res, next) => {
  const best = agent.choose(BACKENDS);
  const target = best.url;

  best.activeRequests += 1;
  best.totalRequests += 1;

  const startTs = Date.now();
  console.log(`[Proxy] Routing to: ${best.name} (${target})`);

  // use pre-created proxy middleware
  const proxy = best.proxy;

  // hook into response finish/error
  res.on("finish", () => {
    const duration = Date.now() - startTs;
    best.activeRequests -= 1;

    // treat 5xx as error
    let isError = false;
    if (res.statusCode >= 500) {
      best.errorRequests += 1;
      isError = true;
    }
    best.errorRate = best.errorRequests / best.totalRequests;

    // RL Update
    agent.update(best, duration, isError);
  });

  res.on("close", () => {
    if (best.activeRequests > 0) best.activeRequests -= 1;
  });

  return proxy(req, res, next);
});

app.listen(PORT, () => {
  console.log(`IntelliProxy running at http://localhost:${PORT}`);
});
