// Promise wrapper around the processing worker.

export class Engine {
  constructor() {
    this.worker = new Worker(new URL('./engine/worker.js', import.meta.url), { type: 'module' });
    this.jobs = new Map();
    this.seq = 0;
    this.worker.onmessage = (ev) => {
      const { id, type } = ev.data;
      const job = this.jobs.get(id);
      if (!job) return;
      if (type === 'progress') job.onProgress?.(ev.data.stage, ev.data.fraction);
      else if (type === 'result') { this.jobs.delete(id); job.resolve(ev.data.data); }
      else if (type === 'error') { this.jobs.delete(id); job.reject(new Error(ev.data.message)); }
    };
    this.worker.onerror = (ev) => {
      const err = new Error(ev.message || 'The processing worker crashed (possibly out of memory).');
      for (const job of this.jobs.values()) job.reject(err);
      this.jobs.clear();
    };
  }

  run(type, payload = {}, transfer = [], onProgress = null) {
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      this.jobs.set(id, { resolve, reject, onProgress });
      this.worker.postMessage({ id, type, payload }, transfer);
    });
  }
}
