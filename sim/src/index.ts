// The simulator, minus the engine. Everything here is light enough for the
// app's main bundle: deck building, the exact math, the knobs and their
// labels, the coverage report, the shipped defaults.
//
// simulate.ts is deliberately NOT re-exported at runtime — it is a quarter
// of a megabyte of sequencer. The worker imports it from '@mtg/sim/simulate';
// the trace sheet imports it dynamically. Its types are re-exported below,
// because types are free.
export * from './simConfig.js';
export * from './simDeck.js';
export * from './groups.js';
export * from './manaSources.js';
export * from './manaCost.js';
export * from './canPay.js';
export * from './gameModel.js';
export * from './mulligan.js';
export * from './hypergeom.js';
export * from './combinatorics.js';
export * from './drawOdds.js';
export * from './coverage.js';
export * from './defaults.js';
export * from './behaviorTemplates.js';
export * from './trace.js';
export * from './battlefield.js';
export * from './rng.js';
export type {
  SimCardResult,
  SimContribution,
  SimCostGroup,
  SimLimits,
  SimRequest,
  SimResponse,
  SimResult,
  SimRuleFires,
  SpendRun,
} from './simulate.js';
