# Owed

**What you are owed, in seconds. Try to get a cent more.**

Live arena: https://owed.vantapointlabs.com · Benchmark: [RESULTS.md](RESULTS.md) · Video: [YouTube](VIDEO_LINK)

Owed lets an AI support agent issue PayPal refunds on the spot, with no person in the loop, and makes it impossible to argue the agent into a cent more. The agent keeps PayPal's refund tool by name and shape. Behind Owed that call becomes a proposal: code compares PayPal's capture with the shop's order record, checks PayPal's shipment tracking, earlier refunds and the shop's caps, reserves the amount in a ledger, and only then refunds through PayPal. Anything the records cannot prove goes to a person with the evidence attached.

The benchmark result is in [RESULTS.md](RESULTS.md) (real models, simulated PayPal stand-in). The arena runs on the live PayPal sandbox: every refund it shows carries PayPal's refund id, fetched back from PayPal.

## The arena

One tap, no account. You get two paid sandbox orders with the same facts: a $20 mug with free shipping, PayPal captured $25 because shipping was charged by mistake, so you are owed $5. One message goes to two doors.

- **Door 1, the agent alone.** A strong published prompt, the records in front of it, PayPal's `create_refund` tool. It decides for itself.
- **Door 2, the agent behind Owed.** Same model, same prompt, same tools. Its `create_refund` call goes to Owed, which pays what the records prove and sends the rest to a person.

Every attempt lands on the public board with the rule that decided it and PayPal's refund id. Click an id to see PayPal's own refund record, fetched live.

## How Door 2 decides

Eight rules, in order, in whole cents, in [`src/engine.js`](src/engine.js):

1. Identity: the order exists and belongs to this session.
2. Amount: whole cents, never more than PayPal captured less what was already refunded.
3. Owed by the record: overcharge (capture above the order total), duplicate capture, cancelled before shipping.
4. Claim against the record: "not received" is paid only when PayPal's tracker says cancelled, or shipped and overdue past the shop's limit.
5. Duplicates: money already paid is not paid again.
6. Limits: one-refund cap.
7. Velocity and daily cap per customer, reserved in the same step as the check.
8. Everything else goes to a person. An open PayPal dispute on the payment sends everything to a person.

The asked amount is turned into claims by what the records prove (`claimsFromAmount`), so the amount paid comes from the record and never from the conversation. If the agent ends its turn without proposing a refund, Owed asks the model only what the customer claimed (a tool with no money in it) and, if they asked for money, the record settles what it proves (`settleFromRecord`). A customer owed $5 is paid $5 whether the agent was talked out of it or not. The ledger (`src/ledger.js`) decides and reserves in one synchronous step, so twenty simultaneous requests for the same $5 are paid once.

## PayPal

| Surface | Used for | Where |
|---|---|---|
| Orders v2 with a card payment source | Seeding paid sandbox orders without a buyer click | [`scripts/seed.js`](scripts/seed.js), [`src/paypalRest.js`](src/paypalRest.js) |
| Refunds on captures, with `PayPal-Request-Id` | Every refund at both doors, idempotent per request | `src/paypalRest.js`, [`src/owed.js`](src/owed.js), [`src/server.js`](src/server.js) |
| Order payments read-back | What was captured and refunded so far, summed from PayPal's refunds list | `src/paypalRest.js` |
| Refund read-back | The receipt panel, PayPal's own record for an id | `src/paypalRest.js`, `/api/receipt` |
| Order shipment trackers | Tracking added at seed time and read back as evidence for rule 4 | `src/paypalRest.js`, [`src/pool.js`](src/pool.js) |
| Agent Toolkit tool shape | `create_refund(capture_id, amount?, currency)`, `get_order`, `get_shipment_tracking` by name and parameters | [`scripts/scenarios.js`](scripts/scenarios.js) |

Sandbox only. The client refuses any non-sandbox base URL.

## AI

One pinned open-weight model at both doors (named on the arena page and in `RESULTS.md`), reached through an OpenAI-compatible endpoint. The model reads the customer's message, calls the lookup tools, proposes a refund and writes the reply. At Door 2 it never decides an amount. The benchmark (`scripts/bench.js`) runs any number of models through both doors; the Anthropic Messages format is supported too.

## Run it

```
npm install          # no dependencies; this only checks the Node version (22 or newer)
npm test             # 23 tests: engine, ledger, race, claims, benchmark harness
npm run bench:mock   # the benchmark on a stand-in model, to see it run
cp .env.example .env # add PayPal sandbox keys and a model key
npm run seed -- --test        # create a paid sandbox order, refund $5, read both back
npm run seed -- --count 20    # fill the order pool for the arena
npm start                     # the arena on http://localhost:8787
MODELS=openai:<model> npm run bench   # the real benchmark, writes RESULTS.md
```

Without PayPal keys the arena runs on a labelled stand-in and says so on every screen.

## Deploy

`deploy/` holds a Dockerfile, a compose file and a Caddy site. `SERVER=user@host bash deploy/publish.sh` builds the image on the host, starts the container, copies the pool and results into the data volume and reloads Caddy.

## Small models

[RESULTS-small.md](RESULTS-small.md) runs the same benchmark on three small models a shop might actually deploy. Nemotron 3 Nano 30B paid money not owed on 4 of 48 attacks on its own and 0 of 48 behind Owed; Qwen3 30B withheld the money owed from 3 of 8 honest customers on its own and paid 8 of 8 behind Owed. Gemma 3 27B never called a tool on our endpoint, so its rows are reported but say nothing about the gateway.

## Twenty at once, on the live sandbox

`npm run race` creates two fresh $25 captures and fires twenty sessions at each, all asking for the same $5. Run of 11 Nov 2026: the agent alone (reads PayPal's record, sees no refund, refunds $5) paid twice, $10.00, with PayPal refusing the other eighteen as a previous request in progress; behind Owed one refund of $5.00 was issued and nineteen sessions were told it had already been paid. PayPal's read-back of both captures is printed at the end with the refund ids.

## What is live and what is simulated

- Arena refunds: live PayPal sandbox. Each shows its PayPal refund id and the receipt fetched back from PayPal.
- Benchmark (`RESULTS.md`): real models, simulated PayPal stand-in that enforces the one rule that matters here, a capture cannot be refunded above its amount. Labelled as such wherever shown.
- Tracking: PayPal's order tracker on the sandbox accepts a tracker as SHIPPED and does not allow its status to be changed through the APIs this app can reach, so the arena scenario is "shipped, nothing says lost": a "not received" claim goes to a person. Rule 4 pays when PayPal reports the shipment cancelled or overdue.

## What we do not claim

Not unbreakable, not production ready, not that PayPal alone proves a charge was wrong. The shop's order record is the second half of every decision. Every miss at Door 2 is published on the board with the message that caused it.

## Team

Timotej Cvikl (University of Ljubljana; software engineering, systems where code checks every answer against fixed rules) and Bernard Liu (University of Cambridge; IP and technology governance, owns the rules). Jeremy Wong advised on session security and attacks.

## Licence

MIT. See [LICENSE](LICENSE).
