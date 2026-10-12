// Netlify adapter: runs the same score server as api/arena.js
const handler = require("../../api/arena.js");

exports.handler = async (event) => {
  const req = { method: event.httpMethod, query: event.queryStringParameters || {}, body: undefined };
  if (event.body) {
    try { req.body = JSON.parse(event.isBase64Encoded ? Buffer.from(event.body, "base64").toString() : event.body); }
    catch (e) { req.body = {}; }
  }
  return new Promise((resolve) => {
    const headers = {};
    let code = 200;
    const res = {
      setHeader: (k, v) => { headers[k] = v; },
      status: (c) => { code = c; return res; },
      json: (o) => { headers["Content-Type"] = "application/json"; resolve({ statusCode: code, headers, body: JSON.stringify(o) }); },
      end: () => resolve({ statusCode: code, headers, body: "" })
    };
    Promise.resolve(handler(req, res)).catch(() => resolve({ statusCode: 500, headers, body: JSON.stringify({ error: "Server error" }) }));
  });
};
