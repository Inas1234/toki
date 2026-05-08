import type { ToolCall } from "./toolCalls.js";

const EDIT_EXPLORATION_ONLY_LIMIT = 2;

function isMutationTool(call: ToolCall): boolean {
  return call.tool === "write" || call.tool === "edit";
}

function isExplorationOnlyTool(call: ToolCall): boolean {
  return call.tool === "grep" || call.tool === "find" || call.tool === "ls";
}

function isConcreteEditProgressTool(call: ToolCall): boolean {
  return call.tool === "read" || isMutationTool(call);
}

export interface EditLoopRoundInput {
  calls: ToolCall[];
  mutationSuccessCount: number;
  previousExplorationOnlyRounds: number;
}

export interface EditLoopRoundState {
  explorationOnlyRounds: number;
  shouldEscalateRecovery: boolean;
}

export function isMutationCall(call: ToolCall): boolean {
  return isMutationTool(call);
}

export function evaluateEditLoopRound(input: EditLoopRoundInput): EditLoopRoundState {
  if (input.mutationSuccessCount > 0) {
    return {
      explorationOnlyRounds: 0,
      shouldEscalateRecovery: false
    };
  }

  const hasConcreteProgress = input.calls.some(isConcreteEditProgressTool);
  if (hasConcreteProgress) {
    return {
      explorationOnlyRounds: 0,
      shouldEscalateRecovery: false
    };
  }

  const explorationOnly = input.calls.length > 0 && input.calls.every(isExplorationOnlyTool);
  const explorationOnlyRounds = explorationOnly ? input.previousExplorationOnlyRounds + 1 : 0;

  return {
    explorationOnlyRounds,
    shouldEscalateRecovery: explorationOnlyRounds >= EDIT_EXPLORATION_ONLY_LIMIT
  };
}
