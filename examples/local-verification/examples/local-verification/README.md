# Local synthetic UI dogfooding (DEV-72)

Optional, manual experiment. No new CI gate, production traffic, API key, model charge, release, or external case-study publication. It runs the existing **PR review** demo scene through the real desk UI, not a live PR review. All prompts, tool output and displayed prices are fixtures.

## Fresh checkout

Requirements: Git, Bash, Node 22.12+ (the project's Vite toolchain), npm, and Chromium's OS dependencies. On a minimal Linux image, have an administrator install the Playwright browser dependencies first. Downloads need internet; the scene itself uses only a temporary loopback static server.

```sh
git clone https://github.com/developjik/damon-chat-desk.git
cd damon-chat-desk
bash examples/local-verification/setup.sh
```

The script uses `npm ci`, builds the desk at `/`, clones two first-party tools into ignored `.dogfood-tools/`, checks out exact commits, installs their locked dependencies and Chromium, then runs the example. It refuses dirty tool checkouts and does not reset or delete them. It does not install globally or use an ambiguous unscoped registry package.

| Tool | Source commit | Package identity |
| --- | --- | --- |
| proofshot | `1deedce053a36743d0c877943d38c499c8c62607` | `@developjik/proofshot` 0.1.1 |
| agent-ui-guard | `c07bd3233e10f5d223ef8db29a3ccc265e559d3e` | `agent-ui-guard` 0.1.1; embedded trace version currently says 0.1.0 |

DEV-36 package naming remains unfinished at this experiment's start. DEV-47 (symlink boundary) and DEV-48 (unique run artifacts) were Done. These pins avoid depending on unpublished or differently named packages. This runner imports their built programmatic APIs, including proofshot's source-level static server helper, so updating pins requires revalidation.

For an installed checkout:

```sh
VITE_BASE_PATH=/ npm run build
node examples/local-verification/run.mjs
```

`DOGFOOD_ROOT`, `DOGFOOD_TOOLS`, and `DOGFOOD_OUT` override the app root, tool root, and output directory. Defaults are relative to the current directory. Run from the repository root. Each default run gets a unique directory; when overriding output, choose a fresh directory to avoid stale evidence.

## What actually runs

1. A temporary server serves `dist/`. Fresh browser pages seed demo-only settings before app scripts. Non-loopback-origin HTTP requests are aborted and recorded as failures. No daemon or OpenAI endpoint is configured. Guard contexts block service workers; the local proofshot pages have fresh contexts.
2. proofshot captures the home route and the PR-review scene at desktop 1440×1000 and mobile 390×844. It opens the scenario launcher and clicks the second card. The capture observer waits for the whole turn to finish and fonts to be ready, not merely for an old `.slot.done` element. It compares the **same build twice** to assess repeatability, not to assert an improvement against a prior release. Pixel changes are reported, not a pass/fail gate; capture errors fail the runner.
3. agent-ui-guard runs the same UI action with seed 72. It requires at least one observed stream episode and tool card, all tool cards settled, and store/DOM agreement at idle. Built-ins check modal overlap, stream timeout, tool completion, console/page errors and HTTP 5xx. `.slot.live`, `.tool` and class terminal states map the desk's actual markup. Guard's auto-generated DOM IDs associate cards and turns. `streamEventOrder` is deliberately excluded: an in-process demo is not recorded SSE/WebSocket coverage.
4. An isolated **intentional fault oracle** adds two modal nodes. Success means the guard reports `singleModalAtATime` with a trace and screenshot. This is not a product defect. The healthy run must pass and the oracle must fail for the expected reason, or the command exits nonzero.

No sleeps are substituted for completion checks. This is one fixed plan, not randomized/fuzz coverage, accessibility certification, live provider validation, or a regression baseline. A11y snapshots alone are not axe audits.

## Find and diagnose results

The command prints its full summary and artifact paths. In the newest `.dogfood-output/run-*/`:

- `summary.json`: capture stats, guard result, observed stream/tool counts, oracle result, and blocked network requests.
- `proofshot/report.md` and `report.json`: desktop/mobile base/head/diff images and accessibility snapshots.
- `guard/run-*/report.md`, `trace.json`, `repro.spec.ts`: healthy run; a violation also writes `dom.html` and `failure.png`.
- `guard-fault-oracle/run-*/`: expected modal violation, including failure screenshot/DOM/trace/repro.
- `guard-final.png`: settled desktop view.
- `error.json`: thrown setup/capture/browser/action error after the local server starts. Earlier import/build/install errors appear directly in the terminal.

The generated guard repro refers to custom action names; use this checked-in runner and seed 72 to replay the scene rather than assuming the generated spec contains this example's custom callbacks. Inspect `trace.json` action errors first, then the named invariant/evidence and DOM/screenshot. A nonzero exit with healthy `guard.ok: false` is a real failed experiment, not success just because artifacts exist.

## Findings and adoption cost

Measured on the initial local run: desk `npm ci` and build plus both source-tool installs/builds succeeded. A warm run takes about 25–35 seconds, including four proofshot captures, one healthy guard run and the intentional fault run. Downloads/browser provisioning depend on cache and OS; no portable cold-install timing is claimed. Source clones and Chromium downloads are the main setup cost. Nothing is added to the production dependency graph.

The settled PR-review scene passed: 1 streaming episode, 4 tool cards, no console/page errors or HTTP 5xx, no blocked outbound request. Four capture pairs were below the default 0.1% diff threshold in the recorded warm run. No product defect was found in this narrow scene. Desktop and mobile images were visually inspected for readable Korean, settled output and composer layout.

Friction found in the experiment itself:

- Waiting for `.slot.done` alone initially captured an unrelated old completed slot while the new turn was still streaming. Waiting for controller `busy === false` fixed the harness; the mobile diff fell from about 5.42% to below 0.1%. This was a harness timing error, not a claimed desk defect.
- Default guard attributes are absent from desk markup. Explicit CSS/state/ID mapping and an observation-count assertion prevent a vacuous pass. Wire-order coverage remains out of scope.
- The guard package and embedded trace versions disagree. Record both until the tool owns a version fix.
- Source pins and two browser installations are heavier than a single published package command. A future package/API consolidation could reduce this, after DEV-36 is settled.
- The modal fault oracle confirms the failure path and artifact discovery work, without inventing a real defect count.

Streamscope is deferred: this first PoC found enough installation, contract and timing work to document before adding another tool. Broader scenes, a stable visual baseline, and live daemon/provider coverage are separate decisions.
