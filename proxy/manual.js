const express = require("express");
const http = require("http");
const { createProxyMiddleware } = require("http-proxy-middleware");

const app = express();
const PORT = 3005;

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

// ---- Compute Score Function ----
function computeScore(server) {
    // If the server is marked as DOWN (latency Infinity), return lowest score
    if (!Number.isFinite(server.latency) || server.latency === Infinity) {
        return -Infinity;
    }

    // Scoring weights (manual tuning)
    // Higher score = Better server
    const WEIGHTS = {
        LATENCY: 0.5, // per ms
        LOSS: 10,     // per percent
        ERROR: 100,   // per percent
        QUEUE: 2,     // per item in queue
        LOAD: 1       // per active request
    };

    let score = 1000; // Starting base score

    // Penalties
    const lat = server.latencyEwma || server.latency || 1000;
    score -= lat * WEIGHTS.LATENCY;

    score -= (server.lossPercent || 0) * WEIGHTS.LOSS;
    score -= (server.errorRate || 0) * 100 * WEIGHTS.ERROR;
    score -= (server.queueEwma || server.queue || 0) * WEIGHTS.QUEUE;
    score -= (server.activeRequests || 0) * WEIGHTS.LOAD;

    return score;
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

// ---- routing handler (based on computeScore) ----
app.use("/", (req, res, next) => {
    let best = BACKENDS[0];
    let maxScore = -Infinity;

    // Select Best Backend based on Score
    for (const b of BACKENDS) {
        const s = computeScore(b);
        if (s > maxScore) {
            maxScore = s;
            best = b;
        }
    }

    const target = best.url;

    best.activeRequests += 1;
    best.totalRequests += 1;

    const startTs = Date.now();
    console.log(`[Proxy] Routing to: ${best.name} (${target}) | Score: ${maxScore.toFixed(2)}`);

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
    console.log(`Manual Proxy running at http://localhost:${PORT}`);
});
