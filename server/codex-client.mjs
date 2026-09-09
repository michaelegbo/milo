import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createInterface } from 'node:readline';
import { mkdir, access } from 'node:fs/promises';
import path from 'node:path';
import { EventEmitter } from 'node:events';

async function executable(binary) {
  if (binary.endsWith('.js')) return { command: process.execPath, prefix: [binary] };
  if (process.platform !== 'win32' || binary !== 'codex') return { command: binary, prefix: [] };
  try {
    const { stdout } = await promisify(execFile)('where.exe', ['codex.exe'], { windowsHide: true });
    return { command: stdout.trim().split(/\r?\n/)[0], prefix: [] };
  } catch {
    // npm's Windows shim cannot be spawned directly with shell:false.
    const { stdout } = await promisify(execFile)('where.exe', ['codex.cmd'], { windowsHide: true });
    const script = path.join(path.dirname(stdout.trim().split(/\r?\n/)[0]), 'node_modules', '@openai', 'codex', 'bin', 'codex.js');
    await access(script); return { command: process.execPath, prefix: [script] };
  }
}

// One isolated app-server per local companion. Never reads the host's Codex login.
export class CodexClient extends EventEmitter {
  constructor({ binary = process.env.MILO_CODEX_BIN || 'codex', directory, spawnProcess = spawn }) {
    super(); this.binary = binary; this.directory = directory; this.spawnProcess = spawnProcess;
    this.pending = new Map(); this.sequence = 0;
  }
  async start() {
    if (this.starting) return this.starting;
    this.starting = this.boot().catch(error => { this.stop(); throw error; });
    return this.starting;
  }
  async boot() {
    const home = path.join(this.directory, 'home');
    this.workspace = path.join(this.directory, 'workspace');
    await mkdir(home, { recursive: true, mode: 0o700 });
    await mkdir(this.workspace, { recursive: true, mode: 0o700 });
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => /^(PATH|SYSTEMROOT|WINDIR|TEMP|TMP|LANG|LOCALAPPDATA|APPDATA)$/i.test(key)));
    Object.assign(env, { CODEX_HOME: home, HOME: home, USERPROFILE: home });
    const settings = { cli_auth_credentials_store: 'file', forced_login_method: 'chatgpt', approval_policy: 'never', sandbox_mode: 'read-only',
      web_search: 'disabled', 'history.persistence': 'none', 'otel.log_user_prompt': false,
      'features.shell_tool': false, 'features.unified_exec': false, 'features.apps': false,
      'features.plugins': false, 'features.hooks': false, 'features.memories': false,
      'features.multi_agent': false, 'features.browser_use': false, 'features.computer_use': false,
      'features.image_generation': false, 'features.code_mode': false, 'features.view_image': false,
      'features.skill_search': false, 'features.shell_snapshot': false, 'features.workspace_dependencies': false };
    const args = ['app-server', ...Object.entries(settings).flatMap(([key, value]) => ['-c', `${key}=${JSON.stringify(value)}`])];
    const target = await executable(this.binary).catch(() => { throw new Error('Install the Codex CLI or set MILO_CODEX_BIN to its executable, then restart the companion.'); });
    this.child = this.spawnProcess(target.command, [...target.prefix, ...args], { cwd: this.workspace, env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    this.child.on('error', () => this.fail(new Error('Codex could not start. Install the Codex CLI or set MILO_CODEX_BIN to its executable, then restart the companion.')));
    this.child.on('exit', () => this.fail(new Error('The Codex companion stopped. Restart it and reconnect.')));
    this.child.stderr.on('data', () => {}); // Never log tokens, prompts, or upstream response bodies.
    this.lines = createInterface({ input: this.child.stdout });
    this.lines.on('line', line => {
      let event; try { event = JSON.parse(line); } catch { return; }
      if (event.method && event.id !== undefined) {
        // No command/file/tool approval is ever exposed through Milo's narrow adapter.
        this.send({ id: event.id, error: { code: -32601, message: 'Tools and approvals are unavailable in Milo.' } });
      } else if (event.id !== undefined) {
        const pending = this.pending.get(event.id);
        if (pending) { clearTimeout(pending.timer); this.pending.delete(event.id); event.error ? pending.reject(new Error('Codex rejected the request. Check your sign-in, model access, and usage allowance.')) : pending.resolve(event.result); }
      } else if (event.method) this.emit('notification', event);
    });
    await this.call('initialize', { clientInfo: { name: 'milo_companion', title: 'Milo', version: '1.0.0' }, capabilities: { experimentalApi: true } });
    this.send({ method: 'initialized', params: {} });
  }
  send(message) { this.child?.stdin.write(JSON.stringify(message) + '\n'); }
  call(method, params = {}) {
    return new Promise((resolve, reject) => {
      const id = ++this.sequence;
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error('Codex took too long to respond. Retry or restart the companion.')); }, 30_000);
      this.pending.set(id, { resolve, reject, timer }); this.send({ id, method, params });
    });
  }
  fail(error) {
    for (const request of this.pending.values()) { clearTimeout(request.timer); request.reject(error); }
    this.pending.clear(); this.starting = undefined; this.emit('unavailable', error);
  }
  stop() { this.lines?.close(); this.child?.kill(); this.child = undefined; this.fail(new Error('Codex stopped.')); }

  async reply({ model, effort, instructions, text, signal, onText }) {
    await this.start(); signal.throwIfAborted();
    const { thread } = await this.call('thread/start', { model, cwd: this.workspace, approvalPolicy: 'never', sandbox: 'read-only',
      ephemeral: true, environments: [], dynamicTools: [], selectedCapabilityRoots: [], baseInstructions: instructions });
    let turnId, output = '', settle, settled = false, interrupted = false;
    const completion = new Promise((resolve, reject) => { settle = error => { if (settled) return; settled = true; error ? reject(error) : resolve(output); }; });
    // Attach immediately: completion may precede the turn/start response.
    const listener = event => {
      const p = event.params;
      if (p?.threadId !== thread.id) return;
      if (event.method === 'item/agentMessage/delta') {
        const delta = String(p.delta ?? ''); output += delta;
        if (output.length > 6000) { abort(); return; }
        onText(delta);
      }
      if (event.method === 'turn/completed') settle(p.turn?.status === 'completed' ? undefined : new Error('Codex could not complete this reply. Check your account allowance or try again.'));
    };
    const failed = () => settle(new Error('Codex disconnected during the reply. Restart the companion.'));
    const interrupt = () => turnId ? this.call('turn/interrupt', { threadId: thread.id, turnId }).catch(() => {}) : Promise.resolve();
    const abort = () => { interrupted = true; void interrupt(); settle(new DOMException('Reply stopped', 'AbortError')); };
    this.on('notification', listener); this.on('unavailable', failed);
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
    completion.catch(() => {});
    try {
      if (!signal.aborted) {
        const result = await this.call('turn/start', { threadId: thread.id, model, effort, environments: [], input: [{ type: 'text', text, text_elements: [] }] });
        turnId = result.turn.id;
        if (signal.aborted || interrupted) await interrupt();
      }
      return await completion;
    } finally {
      signal.removeEventListener('abort', abort); this.off('notification', listener); this.off('unavailable', failed);
      await this.call('thread/unsubscribe', { threadId: thread.id }).catch(() => {});
    }
  }
}
