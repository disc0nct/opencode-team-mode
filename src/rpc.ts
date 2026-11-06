import { Rpc } from "@opencode/schema/rpc"

export const TeamRpcDefinition = Rpc.define({
  id: "team-mode",
  methods: {
    status: {
      input: {
        type: "object",
        properties: {
          teamID: { type: "string" },
        },
      },
      output: {
        type: "object",
        properties: {
          teamID: { type: "string" },
          status: { type: "string" },
          membersCount: { type: "number" },
          tasksCount: { type: "number" },
        },
        required: ["teamID", "status"],
      },
    },
    stop: {
      input: {
        type: "object",
        properties: {
          teamID: { type: "string" },
          reason: { type: "string" },
        },
        required: ["teamID"],
      },
      output: {
        type: "object",
        properties: {
          stopped: { type: "boolean" },
        },
        required: ["stopped"],
      },
    },
  },
  events: {
    teamEvent: {
      schema: {
        type: "object",
      },
    },
  },
})

export type TeamRpcContract = typeof TeamRpcDefinition
