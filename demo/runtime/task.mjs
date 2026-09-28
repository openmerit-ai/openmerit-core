import { getTask } from './config.mjs';
import * as support from './fixtures.mjs';
import * as spam from './moderation.mjs';
import * as backfill from './backfill.mjs';
import * as placement from './placement.mjs';
import * as fieldkit from './fieldkit.mjs';

export function taskDefinition(id = 'support') {
  return { ...getTask(id), ...({support,spam,backfill,placement,fieldkit}[id]) };
}
// A container is bound to one task at startup; the browser cannot change it.
export const task = taskDefinition(process.env.DEMO_TASK ?? 'support');
export const { models, targetId, fixtures, verification, smoke, rubric, grade } = task;
