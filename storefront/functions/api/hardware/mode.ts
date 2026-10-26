import { flags } from '../../_lib/env';
import { postJson } from '../../_lib/route';

/** Lets the UI show the visible test-mode notice while STRIPE_LIVE_ENABLED is false. */
export const onRequestPost = postJson(async ({ env }) => ({ test_mode: !flags(env).stripeLive }));
