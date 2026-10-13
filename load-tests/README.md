# Load tests

## Flash sale (k6)

N buyers each try to buy 1 unit of a product with 10 units on sale. Carts are filled first
(not measured), then everyone clicks "Buy" in a short burst. Exactly 10 must end up
CONFIRMED, stock must never go negative, and every request must get an HTTP answer.

```powershell
# All services from the production build (npm run build), quiet logs. The gateway gets
# the per-IP limit raised for THIS process only: k6 sends every buyer from one IP.
$env:LOG_LEVEL = "warn"
node dist/apps/user/main.js          # …and product, order, inventory, payment, notification
$env:RATE_LIMIT_GLOBAL_PER_MIN = "100000"; node dist/apps/gateway/main.js

node scripts/make-test-tokens.js 1000          # 1,000 made-up buyers (dev key, git-ignored)
node load-tests/setup-flash.js new 10          # a fresh product, stock 10, a 30-min sale of 10
$p = Get-Content load-tests/.data/product.txt
k6 run -e PRODUCT_ID=$p -e STOCK=10 -e RATE=250 load-tests/flash-sale.js
node load-tests/verify-flash.js $p 10          # the truth, from the databases
```

| File              | What                                                                                                                                                                                                              |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `flash-sale.js`   | The k6 test. `RATE` = buy clicks per second (default: all within 1 s); `BURST=instant` = all in the same millisecond; `GATE=off` = no sale (with `setup-flash.js … --no-sale`), so the DB alone decides (A/B run) |
| `setup-flash.js`  | `new` creates a dedicated product (no old holds that could change its stock mid-run), sets stock, starts the sale                                                                                                 |
| `verify-flash.js` | Waits for the saga to settle, then checks this run's buyers in the order and inventory databases                                                                                                                  |
| `reports/`        | k6 summaries (`.txt`, `.json`) and verify results, one set per run                                                                                                                                                |

A "good client" is simulated: the same `Idempotency-Key` on every retry, and it waits as
long as `Retry-After` says (plus jitter) after a 429.

## Results (one Windows laptop: all 7 services, Docker and k6 on the same machine)

|                           | 1,000 buyers, 250 clicks/s                                    |
| ------------------------- | ------------------------------------------------------------- |
| HTTP answers              | all 2,000 requests answered; **0 5xx, 0 dropped connections** |
| Sold-out answers          | 962                                                           |
| Orders created (HTTP 201) | 38: 10 with a gate token + 28 that failed open (see below)    |
| **Confirmed in the DB**   | **exactly 10**; the other 28 FAILED (out of stock)            |
| Stock after               | available 0, reserved 10, never negative                      |
| buy p95                   | **8.3 s** (target 800 ms: not met)                            |

**Correctness held**: the verified run above confirmed exactly 10, and in every run stock
never went negative and the DB never confirmed more than it had (we also ran 1,000/s and all
1,000 in the same millisecond; extra orders that slipped past the gate were rejected by the DB
reserve). **The performance targets are not met on this machine.** What we measured:

- **The order service is the bottleneck, CPU-bound on one core.** During a run it used ~21 CPU-s
  vs ~14 for the gateway and ~4.5 for product/inventory. A V8 profile shows 82 % of its CPU time
  in Windows system libraries (`ntdll.dll`) around socket writes to Postgres, Redis and HTTP;
  only 17 % in our JavaScript. Each "sold out" answer still costs ~10 network round trips
  (idempotency claim + release in Postgres, the checkout lock, the cart, the gate), and on
  Windows each one is expensive.
- **Gate fail-opens under overload.** Inventory answered every gate call within 87 ms (p99
  51 ms), but the order service's busy event loop let the 500 ms gate timeout expire first, so
  the gate failed open and those buyers got an order that the DB later rejected. Correct, but
  it is exactly the extra work the gate exists to avoid.
- **Connections refused at the OS.** With all buyers in the same millisecond (or 1,000/s), a
  third to a half of the connections were refused before the gateway saw them: Windows client
  editions cap the listen queue far below a burst of 1,000 (`HTTP_LISTEN_BACKLOG` didn't help).
  A load balancer in front (or a Linux host) absorbs this.

Next steps to reach the targets: run the services on Linux (WSL / containers) and measure
again; fewer round trips for a losing buyer; decide how the gate should behave on a TIMEOUT
(see the F9 README section).
