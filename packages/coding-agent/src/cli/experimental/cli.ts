import { type ClientCommandContext, clientCommand } from "./commands/client.ts";
import { type ServerCommandContext, serverCommand } from "./commands/server.ts";
import { type PiCommandContext, smoltCommand } from "./commands/smolt.ts";

export type ExperimentalCliContext = PiCommandContext & ServerCommandContext & ClientCommandContext;

export const experimentalCli = smoltCommand.command(serverCommand).command(clientCommand);
