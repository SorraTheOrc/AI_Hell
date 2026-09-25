/**
 * Regression test for the GitHub Pages deploy workflow trigger contract
 * (AH-0MUG2CG4Y000LDYF).
 *
 * Releases publish only when a `v*` tag is pushed. `.github/workflows/deploy-pages.yml`
 * encodes that contract via `on.push.tags`; this test pins the trigger shape so a
 * future workflow edit cannot silently start deploying on branch pushes or pull
 * requests — which would break the tag-only release contract and the ship
 * wrapper's release merge (see AH-0MUFGUR9C003XD77).
 *
 * The test is hermetic: it reads only the checked-out workflow file and uses no
 * YAML dependency (only small, purpose-built block extractors), so `npm test`
 * stays runnable in a clean CI checkout.
 *
 * Runs in the Node environment (not happy-dom) because it reads the filesystem.
 *
 * @vitest-environment node
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const WORKFLOW_PATH = fileURLToPath(
  new URL('../.github/workflows/deploy-pages.yml', import.meta.url),
);

const workflow = readFileSync(WORKFLOW_PATH, 'utf8');

/**
 * Return the top-level `on:` block: its header line plus every following line
 * that is indented (until the next top-level key).
 */
function extractOnBlock(yaml: string): string {
  const lines = yaml.split('\n');
  const start = lines.findIndex((line) => /^on:\s*(#.*)?$/.test(line));
  if (start === -1) return '';
  const block = [lines[start]];
  for (let i = start + 1; i < lines.length; i += 1) {
    if (/^\S/.test(lines[i])) break; // next top-level key
    block.push(lines[i]);
  }
  return block.join('\n');
}

/**
 * Return the body of a job under `jobs:` (its 2-space-indented header plus its
 * 4-space-or-deeper body), or '' when the job is absent. Stops at the next
 * 2-space job header or the next top-level key.
 */
function extractJob(yaml: string, name: string): string {
  const lines = yaml.split('\n');
  const start = lines.findIndex((line) => line === `  ${name}:`);
  if (start === -1) return '';
  const block = [lines[start]];
  for (let i = start + 1; i < lines.length; i += 1) {
    if (/^ {0,2}\S/.test(lines[i])) break; // next job or top-level key
    block.push(lines[i]);
  }
  return block.join('\n');
}

describe('deploy-pages.yml trigger contract', () => {
  it('triggers only on pushes of v* tags', () => {
    const on = extractOnBlock(workflow);
    expect(on).not.toBe('');

    const triggerKeys = on
      .split('\n')
      .filter((line) => /^ {2}[A-Za-z_]+:/.test(line))
      .map((line) => line.trim().replace(/:$/, ''));

    expect(triggerKeys).toEqual(['push']);
    expect(on).toMatch(/^ {2}push:/m);
    expect(on).toMatch(/^ {4}tags:/m);
    expect(on).toMatch(/^ {6}- ['"]?v\*['"]?\s*$/m);
    expect(on).not.toMatch(/^ {4}branches:/m);
  });

  it('does not deploy on non-tag events', () => {
    const on = extractOnBlock(workflow);

    expect(on).not.toMatch(/pull_request/);
    expect(on).not.toMatch(/workflow_dispatch/);
    expect(on).not.toMatch(/schedule/);
    expect(on).not.toMatch(/branches:/);
    // `tags` must not be combined with a branch filter anywhere in the file.
    expect(workflow).not.toMatch(/^ {4}branches:/m);
  });

  it('deploys to the github-pages environment from a job that needs the build', () => {
    const build = extractJob(workflow, 'build');
    const deploy = extractJob(workflow, 'deploy');

    expect(build).not.toBe('');
    expect(deploy).not.toBe('');
    expect(deploy).toMatch(/^ {4}needs:\s*build\s*$/m);
    expect(deploy).toMatch(/^ {4}environment:\s*$/m);
    expect(deploy).toMatch(/^ {6}name:\s*github-pages\s*$/m);
  });

  it('declares exactly the build and deploy jobs', () => {
    const lines = workflow.split('\n');
    const jobsStart = lines.findIndex((line) => /^jobs:\s*$/.test(line));
    expect(jobsStart).toBeGreaterThanOrEqual(0);

    const jobNames = lines
      .slice(jobsStart + 1)
      .filter((line) => /^ {2}\S/.test(line))
      .map((line) => line.trim().replace(/:$/, ''));

    expect(jobNames).toEqual(['build', 'deploy']);
  });
});
