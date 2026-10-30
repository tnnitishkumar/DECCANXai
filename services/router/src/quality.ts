import type { TaskClass } from "#shared";

/**
 * Quality tiers are DATA, not code (spec: "adapters rather than hardcoding model names").
 * An operator supplies ordered rules; the first rule whose regex matches "provider/model"
 * wins. Tiers are the operator's judgement in [0,1], not a measured benchmark.
 * Models matching no rule get the neutral default tier.
 */
export interface QualityRule {
  /** Regex source, matched case-insensitively against "provider/modelId". */
  pattern: string;
  tier: number;
  /** Optional per-task-class overrides, e.g. { coding: 0.95 }. */
  taskClasses?: Partial<Record<TaskClass, number>>;
}

export class QualityTable {
  private readonly compiled: Array<{ re: RegExp; rule: QualityRule }>;
  readonly defaultTier: number;

  constructor(rules: QualityRule[] = [], defaultTier = 0.5) {
    const inRange = (n: number) => Number.isFinite(n) && n >= 0 && n <= 1;
    if (!inRange(defaultTier)) throw new Error("defaultTier must be within [0,1]");
    this.defaultTier = defaultTier;
    this.compiled = rules.map((rule) => {
      if (!inRange(rule.tier)) throw new Error(`tier for '${rule.pattern}' must be within [0,1]`);
      for (const v of Object.values(rule.taskClasses ?? {})) {
        if (v === undefined || !inRange(v)) throw new Error(`task-class tier for '${rule.pattern}' must be within [0,1]`);
      }
      return { re: new RegExp(rule.pattern, "i"), rule };
    });
  }

  tierFor(provider: string, modelId: string, taskClass: TaskClass = "general"): number {
    const id = `${provider}/${modelId}`;
    for (const { re, rule } of this.compiled) {
      if (re.test(id)) return rule.taskClasses?.[taskClass] ?? rule.tier;
    }
    return this.defaultTier;
  }
}
