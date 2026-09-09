import { freemem } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execute = promisify(execFile);
const GiB = 1024 ** 3;
// GGUF/context estimates at 6144 tokens are 1.42/3.50 GiB respectively.
// These budgets include additional JS/native runtime headroom.
export const MODEL_RAM_BUDGET = Object.freeze({ fast: 2 * GiB, quality: 4.5 * GiB });
export const MEMORY_RESERVE = 2 * GiB;
let cached;
let cachedAt = 0;

// libuv's process.availableMemory includes Linux cgroup limits and usage;
// os.freemem alone can report the entire host's RAM inside a container.
export function availableChatMemory(physical = freemem(), available = process.availableMemory?.(), constrained = process.constrainedMemory?.()) {
  const values = [physical];
  if (Number.isFinite(available) && available >= 0) values.push(available);
  if (Number.isFinite(constrained) && constrained > 0) values.push(constrained);
  return Math.max(0, Math.min(...values));
}

export async function readChatMemoryBudget({ refresh = false } = {}) {
  const physical = availableChatMemory();
  if (!refresh && cached && Date.now() - cachedAt < 5000) return { ...cached, freeBytes: Math.min(cached.freeBytes, physical) };
  let commitFreeBytes = null;
  let freeBytes = physical;
  let reliable = process.platform !== 'win32';
  if (process.platform === 'win32') {
    try {
      const { stdout } = await execute('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', 'Get-CimInstance Win32_PerfFormattedData_PerfOS_Memory | Select-Object AvailableBytes,CommittedBytes,CommitLimit | ConvertTo-Json -Compress'], { windowsHide: true, timeout: 4000, maxBuffer: 4096 });
      const value = JSON.parse(stdout.trim());
      if (Number.isFinite(value.AvailableBytes) && Number.isFinite(value.CommittedBytes) && Number.isFinite(value.CommitLimit)) {
        freeBytes = Math.min(physical, value.AvailableBytes);
        commitFreeBytes = Math.max(0, value.CommitLimit - value.CommittedBytes);
        reliable = true;
      }
    } catch { /* Keep single-model operation when Windows commit cannot be read. */ }
  }
  cached = { freeBytes, commitFreeBytes, reliable };
  cachedAt = Date.now();
  return { ...cached };
}

export function canAdmitModels(memory, missingProfiles) {
  const needed = missingProfiles.reduce((total, profile) => total + MODEL_RAM_BUDGET[profile], 0) + MEMORY_RESERVE;
  return memory.reliable && memory.freeBytes >= needed && (memory.commitFreeBytes == null || memory.commitFreeBytes >= needed);
}
