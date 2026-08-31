import { parentPort, workerData } from 'node:worker_threads';
import { setInterval, setTimeout } from 'node:timers';
import { TextDecoder } from 'node:util';

const input = new TextDecoder().decode(new Uint8Array(workerData.bytes));

if (input === 'hang') {
  setInterval(() => undefined, 60_000);
} else {
  const [command, delayText = '0', ...rest] = input.split(':');
  const delay = Number(delayText);
  setTimeout(
    () => {
      if (command === 'oversize') {
        parentPort.postMessage({ ok: true, text: 'x'.repeat(workerData.maxChars + 10_000) });
        return;
      }
      parentPort.postMessage({ ok: true, text: rest.join(':') || command });
    },
    Number.isFinite(delay) ? delay : 0
  );
}
