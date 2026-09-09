import test from 'node:test';
import assert from 'node:assert/strict';
import { availableChatMemory, canAdmitModels } from './chat-memory-budget.mjs';

const GiB = 1024 ** 3;

test('container available memory bounds Hybrid admission even when host has spare RAM', () => {
  const freeBytes = availableChatMemory(24 * GiB, 6 * GiB, 10 * GiB);
  assert.equal(freeBytes, 6 * GiB);
  assert.equal(canAdmitModels({ freeBytes, reliable: true }, ['fast', 'quality']), false);
  assert.equal(canAdmitModels({ freeBytes, reliable: true }, ['fast']), true);
});

test('zero available memory stays zero and an unconstrained process uses physical headroom', () => {
  assert.equal(availableChatMemory(24 * GiB, 0, 10 * GiB), 0);
  assert.equal(availableChatMemory(6 * GiB, 24 * GiB, 0), 6 * GiB);
  assert.equal(availableChatMemory(24 * GiB, 20 * GiB, 10 * GiB), 10 * GiB);
});
