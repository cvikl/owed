# Owed

**What you are owed, in seconds. Try to get a cent more.**

Live arena: https://owed.vantapointlabs.com · Benchmark: [RESULTS.md](RESULTS.md) · Video: [YouTube](VIDEO_LINK)

Give an AI the refund button and the amount it pays depends on how its instructions were worded. Loose wording risks paying people who are not owed. Strict wording risks turning away people who are. We measured this with a test suite we wrote ourselves (adversarial test cases and, separately, legitimate ones), changing nothing but the instructions. Each model ran each case once, and every refund call it made was replayed unchanged through Owed's gate, so the comparison shares one model output. Method, ground truth and numbers are in [RESULTS.md](RESULTS.md).

With Owed the AI still reads the customer's message and still asks for the refund with the same `create_refund` call. That call stops being an order and becomes a proposal. Code compares PayPal's capture with the shop's order record, checks PayPal's shipment tracking and earlier refunds, and pays exactly what those records prove, through PayPal, to the cent. Anything the records cannot prove goes to a person with the evidence attached. Door 2 never pays before the AI has run. It has one step Door 1 does not: if the AI ends without making a refund call, the model is asked once what the customer claimed, and if money was claimed the record settles what it proves.

The benchmark uses real models with a PayPal stand-in so anyone can rerun it with one command. The arena runs on the live PayPal sandbox, and every refund it shows carries PayPal's own refund id, fetched back from PayPal. The public board is a record of what visitors tried. It is not part of the benchmark, and a visitor's words appear on it only if they ticked the box to share them.

**Limits, said plainly.** This is a single-process hackathon build. The ledger and the daily limits live in memory. Before each decision Owed reconciles refunds already visible in PayPal, which reduces duplicate payment after a restart but does not make it safe across several processes. A production deployment needs a transactional database with row locking, identity binding between a conversation and an order, and a staffed review queue. It has only ever run on the PayPal sandbox.

## The arena

No account. You get two paid sandbox orders with the same facts. A $20 mug with free shipping, PayPal captured $25 because shipping was charged by mistake, so you are owed $5. One message goes to two doors.

- **Door 1, the AI alone.** It holds PayPal's refund tool and decides for itself.
- **Door 2, the same AI behind Owed.** Same model, same instructions, same tools. Its refund call goes to Owed.

You choose the shop's instructions to its AI (none at all, a typical shop, the strictest we could write, or your own words). Both doors always get the same ones. Change them and watch which door's result changes.

Every attempt lands on the public board with the instructions in force, the rule that decided it and PayPal's refund id. Click an id to see PayPal's own refund record, fetched live.

## How Door 2 decides

Eight rules, in order, in whole cents, in [`src/engine.js`](src/engine.js):

1. Identity: the order exists and belongs to this session.
2. Amount: whole cents, never more than PayPal captured less what was already refunded.
3. Owed by the record: overcharge (capture above the order total), duplicate capture, cancelled before shipping.
4. Claim against the record: "not received" is paid only when PayPal's tracker says cancelled, or shipped and overdue past the shop's limit.
5. Duplicates: money already paid is not paid again.
6. Limits: one-refund cap.
7. Velocity and daily cap per customer, reserved in the same step as the check.
8. Everything else goes to a person. When `CHECK_DISPUTES=1` is set, an open PayPal dispute on the payment sends everything to a person.

The asked amount is turned into claims by what the records prove (`claimsFromAmount`), so the amount paid comes from the record and never from the conversation. If the agent ends its turn without proposing a refund, Owed asks the model only what the customer claimed (a tool with no money in it) and, if they asked for money, the record settles what it proves (`settleFromRecord`). A customer owed $5 is paid $5 whether the agent was talked out of it or not. The ledger (`src/ledger.js`) decides and reserves in one synchronous step, so twenty simultaneous requests for the same $5 are paid once.

## PayPal

| Surface | Used for | Where |
|---|---|---|
| Orders v2 with a card payment source | Seeding paid sandbox orders without a buyer click | [`scripts/seed.js`](scripts/seed.js), [`src/paypalRest.js`](src/paypalRest.js) |
| Refunds on captures, with `PayPal-Request-Id` | Every refund at both doors, idempotent per request | `src/paypalRest.js`, [`src/owed.js`](src/owed.js), [`src/server.js`](src/server.js) |
| Order payments read-back | What was captured and refunded so far, summed from PayPal's refunds list | `src/paypalRest.js` |
| Refund read-back | The receipt panel, PayPal's own record for an id | `src/paypalRest.js`, `/api/receipt` |
| Order shipment trackers | Tracking added at seed time and read back as evidence for rule 4 | `src/paypalRest.js`, [`src/pool.js`](src/pool.js) |
| PayPal Agent Toolkit tool interface | The AI's PayPal tools (`get_order`, `get_shipment_tracking`, `create_refund`) have the names and parameters of `@paypal/agent-toolkit` 1.11.0, copied from its source. Optional: when the package is installed, Door 1's refund is executed by the toolkit's own code. The page says so only when that is the case | [`scripts/scenarios.js`](scripts/scenarios.js), [`src/toolkit.js`](src/toolkit.js) |

Sandbox only. The client refuses any non-sandbox base URL.

## AI

One pinned open-weight model at both doors (named on the arena page and in `RESULTS.md`), reached through an OpenAI-compatible endpoint. The model reads the customer's message, calls the lookup tools, proposes a refund and writes the reply. At Door 2 it never decides an amount. The benchmark (`scripts/bench.js`) runs any number of models through both doors; the Anthropic Messages format is supported too.

## PayPal's Agent Toolkit (optional)

```
npm install @paypal/agent-toolkit@1.11.0   # adds it to package.json, so the Docker build installs it too and fails loudly if it cannot
```

With the package installed and `USE_TOOLKIT` not set to 0, Door 1's `create_refund` is executed by the toolkit (`handleToolCall` from `@paypal/agent-toolkit/openai`; source `typescript/src/openai/toolkit.ts` in github.com/paypal/agent-toolkit at version 1.11.0, commit a3aa963). Door 2 keeps the same proposal interface and pays the approved amount through our own PayPal REST client. `/api/config` reports `toolkit.installed`, and `toolkit.verified` turns true after the first refund PayPal confirms through it. Without the package everything runs on our own REST client and the page makes no toolkit claim beyond the tool interface.

## AI tools used to build this

The models named in RESULTS.md run inside the product. Claude (Anthropic) was used to help write and review code, tests and documents. TIM: add any other assistant you used here, by name, before submitting. The rules ask for it.

## Run it

```
npm install          # no dependencies; this only checks the Node version (22 or newer)
npm test             # 29 tests, plus one that runs only when PayPal's Agent Toolkit is installed
MODELS=openai:<id> npm run bench:smoke               # 5 cases of each test, to check the wiring. Writes RESULTS-smoke.md
MODELS=openai:<id>,openai:<id> npm run bench:dial    # the benchmark: typical and strictest instructions, one run, temperature 0
MODELS=openai:<id>,openai:<id> npm run bench:bare    # optional extra: no instructions at all. Writes RESULTS-bare.md
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
