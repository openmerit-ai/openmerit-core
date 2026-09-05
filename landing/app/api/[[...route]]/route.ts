import {handle} from 'hono/vercel';
import {app} from '@openmerit/server';
export const runtime = 'nodejs';
export const maxDuration = 120;
export const GET = handle(app);
export const POST = handle(app);
export const DELETE = handle(app);
