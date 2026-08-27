import type { ProviderStreams } from "../types.ts";
import { lazyApi } from "./lazy.ts";

export const smoltMessagesApi = (): ProviderStreams => lazyApi(() => import("./smolt-messages.ts"));
