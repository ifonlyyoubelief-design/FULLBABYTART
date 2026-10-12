// Baby Tart Arena: score API (Vercel serverless function at /api/arena, Upstash Redis)
// Env vars: UPSTASH_REDIS_REST_URL, UPSTASH_REDIS_REST_TOKEN, ARENA_ADDRESS, BSC_RPC (optional)
// package.json needs: { "dependencies": { "ethers": "6.13.4" } }
const { verifyMessage, JsonRpcProvider, Contract, Network } = require("ethers");
const URL_ = process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL;
const TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN;
const ARENA = process.env.ARENA_ADDRESS;
const RPC = process.env.BSC_RPC || "https://bsc-dataseed.binance.org";
const ROUND = 3 * 60 * 60 * 1000;
const GAMES = ["run", "stack"];
const crypto = require("crypto");

async function redis(cmd) {
  const r = await fetch(URL_, { method: "POST", headers: { Authorization: "Bearer " + TOKEN }, body: JSON.stringify(cmd) });
  return (await r.json()).result;
}

let provider;
async function hasEntered(round, addr) {
  provider = provider || new JsonRpcProvider(RPC, 56, { staticNetwork: Network.from(56) });
  const c = new Contract(ARENA, ["function paidIn(uint256,address) view returns (uint256)"], provider);
  return (await c.paidIn(round, addr)) > 0n;
}

// Highest plausible score for the time a session lasted (rejects scripted/impossible scores).
function maxScore(game, secs) {
  return game === "run" ? secs * 60 + 60 : secs / 0.4 + 2;
}

module.exports = async (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Access-Control-Allow-Origin", "*"); // tighten to your domain in production
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(204).end();
  try {
    const now = Date.now(), round = Math.floor(now / ROUND);

    if (req.method === "GET") {
      const g = GAMES.includes(req.query.game) ? req.query.game : "run";
      const r = Number.isInteger(+req.query.round) ? +req.query.round : round;
      const z = (await redis(["ZREVRANGE", `arena:${r}:${g}`, 0, 9, "WITHSCORES"])) || [];
      const rows = [];
      for (let i = 0; i < z.length; i += 2) rows.push({ addr: z[i], score: +z[i + 1] });
      return res.status(200).json({ round, now, end: (round + 1) * ROUND, rows });
    }

    if (req.method === "POST") {
      const b = req.body || {};

      // 1) Start a ranked run. The wallet must have paid the entry fee for this round on-chain.
      if (b.action === "start") {
        if (!/^0x[0-9a-fA-F]{40}$/.test(b.addr || "") || !GAMES.includes(b.game)) return res.status(400).json({ error: "Bad request" });
        if (!(await hasEntered(round, b.addr))) return res.status(403).json({ error: "Join this round first" });
        const sid = crypto.randomBytes(16).toString("hex");
        await redis(["SET", `sess:${sid}`, JSON.stringify({ addr: b.addr.toLowerCase(), game: b.game, round, t: now }), "EX", 1800]);
        return res.status(200).json({ sid, round });
      }

      // 2) Submit the score for that run, signed by the wallet.
      if (b.action === "score") {
        const { sid, score, sig } = b;
        if (typeof sid !== "string" || !/^[0-9a-f]{32}$/.test(sid) || typeof sig !== "string" || !Number.isInteger(score) || score < 1 || score > 5000)
          return res.status(400).json({ error: "Invalid score" });
        const raw = await redis(["GETDEL", `sess:${sid}`]); // one use only
        if (!raw) return res.status(400).json({ error: "Session expired or already used" });
        const s = JSON.parse(raw);
        if (s.round !== round) return res.status(400).json({ error: "Round ended before the score was sent" });
        const secs = (now - s.t) / 1000;
        if (secs < 2 || score > maxScore(s.game, secs)) return res.status(400).json({ error: "Score not plausible" });
        const msg = `Baby Tart Arena\nSession: ${sid}\nGame: ${s.game}\nScore: ${score}`;
        let who = "";
        try { who = verifyMessage(msg, sig); } catch (e) {}
        if (who.toLowerCase() !== s.addr) return res.status(401).json({ error: "Signature does not match wallet" });
        const key = `arena:${round}:${s.game}`;
        await redis(["ZADD", key, "GT", score, s.addr]);
        await redis(["EXPIRE", key, 60 * 60 * 24 * 30]);
        return res.status(200).json({ ok: true, round });
      }
      return res.status(400).json({ error: "Bad request" });
    }
    return res.status(405).json({ error: "Method not allowed" });
  } catch (e) {
    return res.status(500).json({ error: "Server error" });
  }
};
