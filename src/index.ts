import { Plugin } from "@opencode/plugin"
import type { Context } from "@opencode/plugin/promise/plugin"
import { createCommand } from "./commands.ts"
import { validateConfig } from "./core/config.ts"
import { makeIds } from "./core/ids.ts"
import { TeamStore } from "./core/store.ts"
import { TeamService } from "./core/team-service.ts"
import { registerHooks } from "./hooks.ts"
import { createHost, createLogger } from "./host.ts"
import { createTools } from "./tools.ts"

export { createTools } from "./tools.ts"
export { createCommand } from "./commands.ts"
export { registerHooks } from "./hooks.ts"
export { TeamService } from "./core/team-service.ts"
export { TeamStore } from "./core/store.ts"
export { createHost, createLogger } from "./host.ts"
export { validateConfig, DEFAULT_LIMITS, DEFAULT_ROLES } from "./core/config.ts"

export const teamModePlugin = Plugin.define({
  id: "team-mode",
  async setup(context: Context) {
    const config = validateConfig(context.options)
    const logger = createLogger(config.logLevel)
    logger.info("initializing team-mode plugin", { version: "0.1.0" })

    const host = createHost(context, logger)
    const clock = { now: () => Date.now() }
    const ids = makeIds(clock)
    const store = new TeamStore(host.storage, clock, ids)
    const service = new TeamService(host, store, clock, ids, config)

    const tools = createTools(service)
    const unregisterTools = await host.registerTools(tools)

    const command = createCommand(service, host)
    const unregisterCommand = await host.registerCommand(command)

    const hookDisposables = await registerHooks(service, host)

    service.startSweeper()

    try {
      await service.recover()
    } catch (error) {
      logger.warn("startup recovery encountered error", {
        error: error instanceof Error ? error.message : String(error),
      })
    }

    return async () => {
      logger.info("unloading team-mode plugin")
      service.stopSweeper()
      await hookDisposables.dispose()
      await unregisterTools()
      await unregisterCommand()
    }
  },
})

export default teamModePlugin
