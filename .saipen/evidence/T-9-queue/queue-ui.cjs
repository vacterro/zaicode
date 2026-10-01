const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const assertCompleted = text => assert.match(text, /Completed/, `dispatched runtime completes: ${text}`);

module.exports = async function checkQueue({ page, app, profile, outDir }) {
  await page.setViewportSize({ width: 1600, height: 1000 });
  await page.getByTestId('project-add').click();
  await page.getByRole('menuitem', { name: 'Open folder', exact: true }).click();
  await page.locator('[data-testid^="workspace-item"]').filter({ hasText: 'first-project' }).first().waitFor();
  await page.getByTestId('zaicode-sidebar-open').click();
  const roster = page.locator('[data-zaicode-tour="agents"]');
  const inspector = page.locator('[data-zaicode-tour="inspector"]');
  const queue = page.locator('[data-zaicode-tour="queue"]');
  await roster.waitFor({ state: 'visible' });
  const autopilot = page.getByRole('button', { name: 'Autopilot: on', exact: true });
  if (await autopilot.count()) await autopilot.click();
  await roster.locator('button[title="New agent"]').click();
  const agentName = 'T9 isolated queue smoke';
  await inspector.locator('label').filter({ hasText: /^Name$/ }).locator('input').fill(agentName);
  await inspector.locator('textarea').fill('Reply briefly. Do not edit files, execute commands, create agents, or contact other people.');
  await inspector.getByRole('button').filter({ has: page.getByText('SAIFREN', { exact: true }) }).first().click();
  await inspector.getByRole('button', { name: 'Save', exact: true }).click();
  await roster.getByText(agentName, { exact: true }).waitFor();
  // Close the narrow inspector through its visible control if it covers the queue.
  const close = inspector.locator('button[title="Close"]:visible');
  if (await close.count()) await close.click();
  await queue.getByRole('button', { name: 'New task', exact: true }).first().click();
  const task = 'Reply exactly QUEUE_E2E_PONG. Do not use tools or edit files.';
  await queue.locator('textarea').fill(task);
  await queue.getByRole('button', { name: 'Add task', exact: true }).click();
  const row = queue.locator('[role="button"]').filter({ hasText: task }).first();
  await row.waitFor();
  const waitingText = await row.innerText();
  assert.match(waitingText, /Queued|Ready/, 'job is waiting in the queue before manual dispatch');
  assert.throws(() => assertCompleted(waitingText), { name: 'AssertionError' }, 'completion oracle rejects the real pre-dispatch queued state');
  if (outDir) await page.screenshot({ path: path.join(outDir, 'queue-ready.png') });
  await row.getByRole('button', { name: 'Run', exact: true }).click();
  const observations = [];
  const deadline = Date.now() + 240000;
  while (Date.now() < deadline) {
    const text = await row.innerText();
    const status = /Completed|Failed|Blocked|Cancelled|Running|Starting|Queued|Ready/.exec(text)?.[0];
    if (status && observations.at(-1) !== status) observations.push(status);
    if (/Completed|Failed|Blocked|Cancelled/.test(status || '')) break;
    await sleep(1000);
  }
  const finalText = await row.innerText();
  assertCompleted(finalText);
  await row.click();
  assert.match(await inspector.innerText(), /SAIFREN/, 'inspector shows the selected free pool');
  if (outDir) await page.screenshot({ path: path.join(outDir, 'queue-completed.png') });
  // Independent read-only confirmation of the host-owned queue row.
  const databases = [];
  function find(dir, depth) {
    if (depth > 6) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory() && !['router', 'Cache', 'Code Cache', 'GPUCache'].includes(entry.name)) find(file, depth + 1);
      else if (entry.isFile() && entry.name === 'tasks-index.sqlite') databases.push(file);
    }
  }
  find(profile, 0);
  let receipt;
  for (const file of databases) {
    const db = new DatabaseSync(file, { readOnly: true });
    try {
      const job = db.prepare('SELECT job_id,status,agent_id,session_id,run_id,attempt,started_at,finished_at,actual_model_selection FROM zaicode_jobs WHERE instructions = ?').get(task);
      if (!job) continue;
      assert.equal(job.status, 'completed');
      assert.ok(job.session_id && job.run_id && job.started_at && job.finished_at);
      const selection = JSON.parse(job.actual_model_selection);
      assert.equal(selection.modelId, 'SAIFREN');
      const agent = db.prepare('SELECT name,model_selection FROM zaicode_agents WHERE agent_id = ?').get(job.agent_id);
      assert.equal(agent.name, agentName);
      assert.equal(JSON.parse(agent.model_selection).modelId, 'SAIFREN');
      receipt = { job, agent: { name: agent.name, modelSelection: JSON.parse(agent.model_selection) }, observations,
        instrumentControl: 'Before Run, the same completion oracle rejected the real Queued row' };
      break;
    } finally { db.close(); }
  }
  assert.ok(receipt, 'real host-owned database contains the completed queue job');
  return receipt;
};
