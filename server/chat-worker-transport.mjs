import { Worker } from 'node:worker_threads';
import { fork } from 'node:child_process';
import { ChatError } from './chat-config.mjs';

/** GPU libraries live in a short-lived process so OFF releases native state. */
export function createChatWorkerTransport({ profile, gpu }) {
  if (!gpu) return new Worker(new URL('./chat-worker.mjs', import.meta.url), { workerData: { profile } });
  const child = fork(new URL('./chat-worker.mjs', import.meta.url), [profile, gpu.backend], {
    windowsHide: true, serialization: 'advanced', execArgv: [],
    stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
    env: { ...process.env, ...gpu.environment },
  });
  let termination;
  return {
    on(event, listener) { child.on(event, listener); },
    postMessage(event) {
      if (!child.connected) throw new ChatError(503, 'chat_worker_disconnected', 'The GPU process disconnected. Switch acceleration off and try again.');
      child.send(event, error => { if (error && child.connected) child.emit('error', error); });
    },
    terminate() {
      if (termination) return termination;
      termination = new Promise((resolve, reject) => {
        if (child.exitCode != null || child.signalCode != null) { resolve(); return; }
        const timer = setTimeout(() => {
          child.off('exit', exited);
          reject(new ChatError(503, 'gpu_stop_timeout', 'The GPU process did not stop. Restart Milo before loading another model.'));
        }, 5000);
        function exited() { clearTimeout(timer); resolve(); }
        child.once('exit', exited);
        // SIGKILL terminates just this child on Windows too. No shell, global
        // service, driver changes, or process-name-wide termination is used.
        child.kill('SIGKILL');
      });
      return termination;
    },
  };
}
