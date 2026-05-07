import { Phase } from "@toki/shared";

export const DEFAULT_PHASES: Phase[] = [
  {
    id: "understand",
    name: "Understand Task",
    goal: "Confirm intent, constraints, and relevant code areas.",
    status: "active",
    entryCriteria: ["New user turn received"],
    exitCriteria: ["TaskFrame extracted", "Candidate context selected"],
    expectedArtifacts: ["TaskFrame", "ContextReceipt"],
    maxContextMode: "normal"
  },
  {
    id: "execute",
    name: "Execute",
    goal: "Produce the next concrete output required for the request.",
    status: "pending",
    entryCriteria: ["Task and context prepared"],
    exitCriteria: ["Model response streamed"],
    expectedArtifacts: ["Assistant response"],
    maxContextMode: "deep"
  },
  {
    id: "verify",
    name: "Verify",
    goal: "Check for gaps and capture known issues.",
    status: "pending",
    entryCriteria: ["Primary response drafted"],
    exitCriteria: ["Checkpoint updated"],
    expectedArtifacts: ["Checkpoint"],
    maxContextMode: "normal"
  }
];
