import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { mkdir, writeFile, stat } from 'node:fs/promises';
const root = resolve(process.env.DOGFOOD_ROOT ?? '.');
const tools = resolve(process.env.DOGFOOD_TOOLS ?? '.dogfood-tools');
const out = resolve(process.env.DOGFOOD_OUT ?? `.dogfood-output/run-${new Date().toISOString().replace(/[:.]/g,'-')}`);
await mkdir(out, { recursive: true });
const require = createRequire(import.meta.url);
const { runCompare } = require(resolve(tools, 'proofshot/dist/src/compare.js'));
const { serveDirectory } = require(resolve(tools, 'proofshot/dist/src/serve.js'));
const { chromium } = await import(pathToFileURL(resolve(tools, 'agent-ui-guard/node_modules/@playwright/test/index.mjs')));
const { runExploration, builtinInvariants, always } = await import(pathToFileURL(resolve(tools, 'agent-ui-guard/dist/index.js')));
const server = await serveDirectory(resolve(root, 'dist'));
const allowed = new URL(server.url).origin;
const blockedRequests = [];
const network = async page => {
  await page.addInitScript(() => localStorage.setItem('damon-desk.v1',JSON.stringify({settings:{transport:'demo',baseUrl:'',memoryEnabled:false,compare:false},conversations:[],activeId:null})));
  await page.route('**/*', route => {
    const url = new URL(route.request().url());
    if(url.origin === allowed) return route.continue();
    blockedRequests.push(url.origin + url.pathname);
    return route.abort('blockedbyclient');
  });
};
const ready = async page => {
  await page.waitForFunction(() => window.__damonDesk?.getSnapshot().connection.status === 'live');
  const transport = await page.evaluate(() => window.__damonDesk.getSnapshot().connection.transport);
  if (transport !== 'demo') throw new Error('Only synthetic demo transport is permitted');
};
let browser;
try {
  const comparison = await runCompare({ cwd: root, base: server.url, head: server.url,
    routes: ['/'], outDir: resolve(out, 'proofshot'), fullPage: true, collectA11y: true,
    viewports: [{name:'desktop',width:1440,height:1000},{name:'mobile',width:390,height:844}],
    scenes: [{name:'synthetic-stream-complete',route:'/',steps:[
      {action:'click',selector:'.scenarios-btn'},
      {action:'click',selector:'.scenario-card:nth-child(2)'},
      {action:'wait',selector:'.slot.done',timeoutMs:30000}
    ],expect:'.slot.done'}],
    observer: { beforeNavigate: network, beforeScene: ready,
      beforeScreenshot: async page => { await ready(page); await page.waitForFunction(() => !window.__damonDesk.getSnapshot().busy); await page.evaluate(() => document.fonts.ready); } },
    failOn: ['error'], log: console.log,
  });
  browser = await chromium.launch({headless:true,args:['--no-sandbox']});
  const context = await browser.newContext({serviceWorkers:'block',viewport:{width:1440,height:1000}});
  const page = await context.newPage();
  await network(page);
  let exercised = false;
  let observed = null;
  const action = { name:'synthetic-turn', async run({page}) {
    await ready(page);
    await page.locator('.scenarios-btn').click();
    await page.locator('.scenario-card').nth(1).click();
    await page.locator('.slot.done').last().waitFor({timeout:30000});
    await page.waitForFunction(() => window.__damonDesk.getSnapshot().busy === false);
    if(await page.locator('.tool').count() < 1) throw new Error('Scenario did not exercise tool cards');
    if(await page.locator('.tool.running').count()) throw new Error('Tool still running after turn');
    exercised = true;
  }};
  const invariants = [ ...builtinInvariants({maxStreamMs:30000,settleTimeoutMs:30000}).filter(i => i.name !== 'streamEventOrder'),
    always('stream-and-tool-observed', ({ledger}) => { if(!exercised) return true; observed={streamEpisodes:ledger.streaming.episodes.length,toolCalls:ledger.toolCalls.length}; return observed.streamEpisodes > 0 && observed.toolCalls > 0; }),
    always('demo-only', async ({page}) => page.evaluate(() => window.__damonDesk?.getSnapshot().connection.transport === 'demo')),
    always('settled-state-agrees-with-dom', async ({page}) => page.evaluate(() => {
      const s=window.__damonDesk?.getSnapshot();
      return !s || s.busy || document.querySelectorAll('.slot.live').length === 0;
    })),
  ];
  const result = await runExploration({page,url:server.url,actions:[action],plan:[{action:action.name}],
    invariants,seed:72,strictActions:true,settleTimeoutMs:30000,outputDir:resolve(out,'guard'),
    contract:{streamingSelector:'.slot.live',toolCallSelector:'.tool',toolCallIdAttr:'data-aug-auto-id',toolCallStateAttr:'class',
      terminalStates:['tool done','tool error'], turnSelector:'.slot',turnIdAttr:'data-aug-auto-turn-id',turnStateAttr:'class',turnCompleteStates:['slot done ','slot error ','slot canceled ']},
  });
  await page.screenshot({path:resolve(out,'guard-final.png'),fullPage:true});
  const faultContext = await browser.newContext({serviceWorkers:'block'});
  const faultPage = await faultContext.newPage();
  await network(faultPage);
  const fault = await runExploration({page:faultPage,url:server.url,seed:72,steps:1,
    actions:[{name:'inject-two-modals',async run({page}) {
      await ready(page);
      await page.evaluate(() => { for(let i=0;i<2;i++) { const el=document.createElement('div'); el.setAttribute('aria-modal','true'); el.textContent='Synthetic fault oracle'; document.body.append(el); } });
    }}], plan:[{action:'inject-two-modals'}],invariants:builtinInvariants(),
    outputDir:resolve(out,'guard-fault-oracle'),shrink:false});
  // The pinned guard can swallow screenshot write errors. Require actual nonempty evidence.
  const oracleArtifacts = {};
  for (const key of ['trace','report','repro','dom','screenshot']) {
    const path = fault.artifacts?.[key];
    oracleArtifacts[key] = typeof path === 'string' && await stat(path).then(s => s.isFile() && s.size > 0, () => false);
  }
  const oracleDetected = !fault.ok && fault.violation?.invariant === 'singleModalAtATime'
    && Object.values(oracleArtifacts).every(Boolean);
  const summary={scene:'synthetic-stream-complete',scenario:'built-in pr-review (synthetic fixture)',transport:'demo',paidCalls:0,blockedRequests,
    comparison:{exitCode:comparison.exitCode,stats:comparison.stats,report:comparison.reportPath},
    guard:{ok:result.ok,observed,violation:result.violation,seed:result.seed,artifacts:result.artifacts},
    faultOracle:{detected:oracleDetected,verifiedArtifacts:oracleArtifacts,violation:fault.violation,artifacts:fault.artifacts},
    limitations:['same-build captures, not a visual regression baseline','one deterministic turn, not broad randomized coverage','no live daemon or provider validation','DOM contract uses existing CSS classes and guard auto-generated IDs','streamEventOrder omitted: demo is in-process, not a captured wire transport','visual changes are reported, not used as a gate; only capture errors fail proofshot']};
  await writeFile(resolve(out,'summary.json'),JSON.stringify(summary,null,2)+'\n');
  console.log(JSON.stringify(summary,null,2));
  if (comparison.exitCode !== 0 || !result.ok || !oracleDetected || blockedRequests.length) process.exitCode=1;
} catch(error) {
  await writeFile(resolve(out,'error.json'),JSON.stringify({message:String(error),stack:error.stack},null,2)+'\n');
  console.error(`Verification failed; inspect ${out}/error.json`);
  throw error;
} finally { if(browser) await browser.close(); await server.close(); }
