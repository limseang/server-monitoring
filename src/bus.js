import { EventEmitter } from 'node:events';

/** In-process event bus. Used to push live updates (jobs, health, events) to the browser via SSE. */
export const bus = new EventEmitter();
bus.setMaxListeners(0);
