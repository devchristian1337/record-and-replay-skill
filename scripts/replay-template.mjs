#!/usr/bin/env node
/**
 * record-and-replay — replay template.
 *
 * When a generated skill genuinely needs UI replay, copy this skeleton and fill
 * in the step list. Rules:
 *   - Use semantic locators, NOT coordinates: getByTestId > getByRole > getByLabel > getByText.
 *   - Verify after every critical step (expect / waitFor).
 *   - Read secrets (passwords, tokens) from env vars; never hard-code them.
 *   - The recorder's persistent profile (logged-in sessions) is reused.
 */

import path from 'node:path';
import os from 'node:os';
import { chromium } from 'playwright';

const PROFILE_DIR = path.join(os.homedir(), '.agents', 'recordings', '.browser-profile');

const context = await chromium
  .launchPersistentContext(PROFILE_DIR, { headless: false, viewport: null, channel: 'chrome' })
  .catch(() => chromium.launchPersistentContext(PROFILE_DIR, { headless: false, viewport: null }));

const page = context.pages()[0] || (await context.newPage());

try {
  // === STEPS — replace with the actions derived from the recording ==========
  await page.goto('https://example.com');

  // e.g. await page.getByRole('button', { name: 'Add expense' }).click();
  // e.g. await page.getByLabel('Amount').fill(process.env.AMOUNT ?? '100');
  // e.g. verification:
  // await page.getByText('Expense saved').waitFor({ timeout: 10_000 });
  // =========================================================================

  console.log(JSON.stringify({ status: 'ok' }));
} catch (error) {
  console.error(JSON.stringify({ status: 'failed', message: String(error && error.message) }));
  process.exitCode = 1;
} finally {
  await context.close();
}
