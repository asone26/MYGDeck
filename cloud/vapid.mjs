// Make the Web Push key for the relay and print it (a private JWK) for `wrangler secret put VAPID_KEY`:
//   node vapid.mjs | npx wrangler secret put VAPID_KEY
// A new key drops every phone's subscription: each turns notifications on again.
const { privateKey } = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
const j = await crypto.subtle.exportKey("jwk", privateKey);
process.stdout.write(JSON.stringify({ kty: "EC", crv: "P-256", x: j.x, y: j.y, d: j.d }));
