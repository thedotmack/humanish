// Action registry.
//
// Every action the box exposes must be listed here. The server's /run
// route looks up the requested action_id in this object — anything not
// present is a hard 404. There is no dynamic loading.

import { GOOGLE_WHOAMI } from "./google.whoami.js";

export const ACTION_REGISTRY = {
  [GOOGLE_WHOAMI.id]: GOOGLE_WHOAMI,
} as const;

export type ActionId = keyof typeof ACTION_REGISTRY;
export const ACTION_IDS: ActionId[] = Object.keys(
  ACTION_REGISTRY,
) as ActionId[];
