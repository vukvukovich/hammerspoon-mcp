#!/usr/bin/env node
/**
 * Transport benchmark: spawn-per-call vs the persistent socket (#19).
 *
 * Run with a real Hammerspoon: node test/bench/transport-bench.mjs
 * Build first: npm run build
 *
 * Recorded on the development machine (M-series, macOS 26, Hammerspoon 1.1.1):
 *
 *   spawn   sequential   8.7-11ms/call
 *   socket  sequential   0.6-0.9ms/call        (~12x)
 *   spawn   40 at once   fails most calls at >=15-way concurrency
 *   socket  40 at once   all succeed, ~25ms total
 */

import { HammerspoonBridge } from '../../dist/bridge/bridge.js';

const SEQUENTIAL_CALLS = 100;
const SIMULTANEOUS_CALLS = 40;

async function measure(label, bridge) {
  const probe = await bridge.run('return 1');
  if (!probe.ok) {
    console.log(`${label}: unavailable (${probe.error.kind}), skipping`);
    return;
  }

  const sequentialStart = process.hrtime.bigint();
  for (let call = 0; call < SEQUENTIAL_CALLS; call += 1) {
    await bridge.run('return 1');
  }
  const sequentialMs = Number(process.hrtime.bigint() - sequentialStart) / 1e6;

  const simultaneousStart = process.hrtime.bigint();
  const results = await Promise.all(
    Array.from({ length: SIMULTANEOUS_CALLS }, () => bridge.run('return 1'))
  );
  const simultaneousMs = Number(process.hrtime.bigint() - simultaneousStart) / 1e6;
  const succeeded = results.filter((result) => result.ok).length;

  console.log(
    `${label}: ${(sequentialMs / SEQUENTIAL_CALLS).toFixed(2)}ms/call sequential, ` +
      `${String(succeeded)}/${String(SIMULTANEOUS_CALLS)} simultaneous in ${simultaneousMs.toFixed(0)}ms`
  );
}

console.log(`sequential=${String(SEQUENTIAL_CALLS)} simultaneous=${String(SIMULTANEOUS_CALLS)}`);
await measure('spawn ', new HammerspoonBridge({ transport: 'spawn' }));
await measure('socket', new HammerspoonBridge({ transport: 'socket' }));
process.exit(0);
