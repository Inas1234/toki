import { Checkpoint, Phase, TaskFrame } from "@toki/shared";
import { DEFAULT_PHASES } from "./phases.js";

export class Orchestrator {
  private phases: Phase[];
  private checkpoint: Checkpoint;

  public constructor(initialTask = "") {
    this.phases = DEFAULT_PHASES.map((phase) => ({ ...phase }));
    this.checkpoint = {
      task: initialTask,
      phase: this.phases[0]?.id ?? "understand",
      completed: [],
      filesChanged: [],
      decisions: [],
      currentState: "Initialized",
      nextSteps: ["Extract task frame", "Select context"],
      knownIssues: [],
      commandsRun: []
    };
  }

  public getCheckpoint(): Checkpoint {
    return { ...this.checkpoint, completed: [...this.checkpoint.completed] };
  }

  public currentPhase(): Phase {
    return this.phases.find((phase) => phase.id === this.checkpoint.phase) ?? this.phases[0]!;
  }

  public advance(task: TaskFrame): void {
    this.checkpoint.task = task.objective;
    const index = this.phases.findIndex((phase) => phase.id === this.checkpoint.phase);
    const nextIndex = Math.min(index + 1, this.phases.length - 1);
    this.phases[index]!.status = "done";
    this.phases[nextIndex]!.status = "active";
    this.checkpoint.phase = this.phases[nextIndex]!.id;
    this.checkpoint.currentState = `Phase ${this.phases[nextIndex]!.name}`;
    this.checkpoint.nextSteps =
      nextIndex === 1 ? ["Generate response"] : ["Verify output", "Capture next issues if any"];
  }

  public markCompleted(step: string): void {
    this.checkpoint.completed.push(step);
  }

  public noteDecision(decision: string): void {
    this.checkpoint.decisions.push(decision);
  }

  public addKnownIssue(issue: string): void {
    this.checkpoint.knownIssues.push(issue);
  }

  public trackCommand(command: string): void {
    this.checkpoint.commandsRun.push(command);
  }

  public trackChangedFile(filePath: string): void {
    if (!this.checkpoint.filesChanged.includes(filePath)) {
      this.checkpoint.filesChanged.push(filePath);
    }
  }
}
