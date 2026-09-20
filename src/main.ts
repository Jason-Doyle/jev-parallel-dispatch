import {
  dispatchCrisis,
  type FanoutBenchmarkEvidence,
  getFanoutEvidence,
  getServerStatus,
} from "./client/api";
import { assignmentCounts, CrisisView, incidentName } from "./client/crisis-view";
import {
  type CounterfactualComparison,
  type CrisisDispatchResult,
  type CrisisFrameMetrics,
  type CrisisSnapshot,
  compareDispatchPolicies,
  roleFit,
} from "./shared/crisis";
import type { DecisionMode, ServerStatus } from "./shared/decision-types";
import "./styles.css";

const app = requireElement<HTMLDivElement>("app");
app.innerHTML = `
  <header class="site-header command-header">
    <div>
      <p class="eyebrow">Parallel decision simulation</p>
      <h1>One Jev call. Dozens of teams. One valid plan.</h1>
      <p class="lede">
        Every response team receives an independent typed decision over one shared world state.
        A deterministic optimiser composes the returned probability matrix into a capacity-safe
        deployment plan.
      </p>
    </div>
    <div class="status-block">
      <span id="server-status" class="status-pill status-pending">Checking server</span>
      <span id="model-status" class="model-label">Model unavailable</span>
    </div>
  </header>

  <main class="command-workspace">
    <aside class="panel command-controls">
      <section>
        <div class="section-heading">
          <span>01</span>
          <h2>Command doctrine</h2>
        </div>
        <label class="field">
          <span>Tell the dispatcher what to value</span>
          <textarea id="doctrine" rows="7">Protect civilians first. Match specialist teams to incidents, avoid overcommitting to one site, and send exhausted teams to recover before they become ineffective.</textarea>
        </label>

        <div class="field-grid">
          <label class="field">
            <span>Decision mode</span>
            <select id="dispatch-mode">
              <option value="jev">Jev fan-out</option>
              <option value="local">Local utility baseline</option>
            </select>
          </label>
          <label class="field">
            <span>Response teams</span>
            <select id="unit-count">
              <option value="8">8 teams</option>
              <option value="16">16 teams</option>
              <option value="32" selected>32 teams</option>
              <option value="48">48 teams</option>
            </select>
          </label>
          <label class="field">
            <span>Simulation speed</span>
            <select id="simulation-speed">
              <option value="1">1x</option>
              <option value="2">2x</option>
              <option value="4" selected>4x</option>
              <option value="8">8x</option>
            </select>
          </label>
        </div>

        <label class="check-field">
          <input id="auto-dispatch" type="checkbox" checked />
          <span>Auto-dispatch every 10 simulation seconds, maximum 8 calls</span>
        </label>

        <p id="mode-note" class="field-note"></p>
        <button id="dispatch" class="primary-button" type="button">
          Dispatch 32 teams
        </button>
        <div id="operation-message" class="operation-message" role="status" aria-live="polite">
          Automatic dispatch will begin when the server and world state are ready.
        </div>
      </section>

      <section>
        <div class="section-heading">
          <span>02</span>
          <h2>Simulation</h2>
        </div>
        <div class="stacked-actions">
          <button id="pause" class="secondary-button" type="button">Start simulation</button>
          <button id="reset" class="secondary-button" type="button">Reset world</button>
          <button id="download-session" class="secondary-button" type="button">
            Download decision trace
          </button>
        </div>
      </section>

      <section>
        <div class="section-heading">
          <span>03</span>
          <h2>What this proves</h2>
        </div>
        <p class="muted-copy">
          Jev supplies one probability distribution per team in a single request. The optimiser
          enforces incident capacities and blends uncertain answers with a deterministic local
          policy. Movement and incident resolution never call the model.
        </p>
      </section>
    </aside>

    <section class="main-column">
      <article class="panel command-panel">
        <div class="panel-title-row">
          <div>
            <p class="eyebrow">Live deterministic world</p>
            <h2>City response operation</h2>
          </div>
          <div id="wave-summary" class="wave-summary">No dispatch wave yet</div>
        </div>
        <canvas
          id="crisis-canvas"
          width="1100"
          height="682"
          aria-label="Live crisis response simulation"
        ></canvas>
        <div class="role-legend">
          <span><i class="role-medic"></i> Medic</span>
          <span><i class="role-engineer"></i> Engineer</span>
          <span><i class="role-firefighter"></i> Firefighter</span>
          <span><i class="role-scout"></i> Scout</span>
          <span>White outline: optimiser changed Jev's top choice</span>
        </div>
      </article>

      <div class="command-lower-grid">
        <article class="panel">
          <div class="panel-title-row">
            <div>
              <p class="eyebrow">World state</p>
              <h2>Operational outcome</h2>
            </div>
          </div>
          <div id="world-metrics" class="metrics-grid command-metrics"></div>
        </article>

        <article class="panel">
          <div class="panel-title-row">
            <div>
              <p class="eyebrow">One model request</p>
              <h2>Fan-out evidence</h2>
            </div>
          </div>
          <div id="call-metrics" class="metrics-grid command-metrics"></div>
          <p id="baseline-comparison" class="metric-warning">
            A matching local baseline will be evaluated automatically after each Jev wave.
          </p>
        </article>
      </div>

      <article class="panel counterfactual-panel">
        <div class="panel-title-row">
          <div>
            <p class="eyebrow">Same snapshot, different policy</p>
            <h2>20-second counterfactual branch</h2>
          </div>
          <span id="counterfactual-summary" class="wave-summary">
            Dispatch with Jev to compare outcomes
          </span>
        </div>
        <div id="counterfactual-grid" class="counterfactual-grid">
          <p class="muted-copy">
            The Jev and local assignments will be applied to cloned worlds with identical future
            incident arrivals.
          </p>
        </div>
      </article>

      <div class="command-lower-grid">
        <article class="panel">
          <div class="panel-title-row">
            <div>
              <p class="eyebrow">Capacity-safe composition</p>
              <h2>Deployment totals</h2>
            </div>
          </div>
          <div id="assignment-summary" class="assignment-summary">
            <p class="muted-copy">No assignments yet.</p>
          </div>
        </article>

        <article class="panel decision-panel">
          <div class="panel-title-row">
            <div>
              <p class="eyebrow">Probability matrix</p>
              <h2>Team decisions</h2>
            </div>
          </div>
          <div class="decision-table-wrap">
            <table class="decision-table">
              <thead>
                <tr>
                  <th>Team</th>
                  <th>Role</th>
                  <th>Jev top choice</th>
                  <th>Assigned</th>
                  <th>Confidence</th>
                </tr>
              </thead>
              <tbody id="decision-rows">
                <tr><td colspan="5">Dispatch teams to populate the matrix.</td></tr>
              </tbody>
            </table>
          </div>
        </article>
      </div>

      <article class="panel benchmark-panel">
        <div class="panel-title-row">
          <div>
            <p class="eyebrow">Measured live API scaling</p>
            <h2>Speculative fan-out benchmark</h2>
          </div>
          <span id="benchmark-meta" class="wave-summary">Loading evidence</span>
        </div>
        <div class="decision-table-wrap benchmark-table-wrap">
          <table class="decision-table benchmark-table">
            <thead>
              <tr>
                <th>Teams</th>
                <th>Total questions</th>
                <th>Median latency</th>
                <th>Decisions / second</th>
                <th>Median input tokens</th>
                <th>Total measured cost</th>
                <th>Capacity violations</th>
                <th>20s branch J / L / T</th>
                <th>Median severity delta</th>
              </tr>
            </thead>
            <tbody id="benchmark-rows">
              <tr><td colspan="9">Loading retained benchmark evidence.</td></tr>
            </tbody>
          </table>
        </div>
        <p class="metric-warning">
          Fresh Jev calls were measured at each scale. Results describe this machine, network
          path, prompt, and model version. Raw responses are retained in
          <code>evidence\\fanout-benchmark.json</code>.
        </p>
      </article>
    </section>
  </main>
`;

const doctrineInput = requireElement<HTMLTextAreaElement>("doctrine");
const modeSelect = requireElement<HTMLSelectElement>("dispatch-mode");
const unitCountSelect = requireElement<HTMLSelectElement>("unit-count");
const speedSelect = requireElement<HTMLSelectElement>("simulation-speed");
const autoDispatchInput = requireElement<HTMLInputElement>("auto-dispatch");
const dispatchButton = requireElement<HTMLButtonElement>("dispatch");
const pauseButton = requireElement<HTMLButtonElement>("pause");
const resetButton = requireElement<HTMLButtonElement>("reset");
const downloadButton = requireElement<HTMLButtonElement>("download-session");
const statusPill = requireElement<HTMLSpanElement>("server-status");
const modelStatus = requireElement<HTMLSpanElement>("model-status");
const modeNote = requireElement<HTMLParagraphElement>("mode-note");
const operationMessage = requireElement<HTMLDivElement>("operation-message");
const worldMetrics = requireElement<HTMLDivElement>("world-metrics");
const callMetrics = requireElement<HTMLDivElement>("call-metrics");
const baselineComparison = requireElement<HTMLParagraphElement>("baseline-comparison");
const counterfactualSummary = requireElement<HTMLSpanElement>("counterfactual-summary");
const counterfactualGrid = requireElement<HTMLDivElement>("counterfactual-grid");
const assignmentSummary = requireElement<HTMLDivElement>("assignment-summary");
const decisionRows = requireElement<HTMLTableSectionElement>("decision-rows");
const waveSummary = requireElement<HTMLDivElement>("wave-summary");
const benchmarkMeta = requireElement<HTMLSpanElement>("benchmark-meta");
const benchmarkRows = requireElement<HTMLTableSectionElement>("benchmark-rows");
const canvas = requireElement<HTMLCanvasElement>("crisis-canvas");

applyQueryDefaults();

let serverStatus: ServerStatus | null = null;
let currentMetrics: CrisisFrameMetrics | null = null;
let currentSnapshot: CrisisSnapshot | null = null;
let lastDispatch: CrisisDispatchResult | null = null;
let lastDispatchSnapshot: CrisisSnapshot | null = null;
let dispatchInFlight = false;
let paused = true;
let lastDispatchSimulationSecond = 0;
let automaticCalls = 0;
let worldRevision = 0;
const sessionTrace: Array<{
  snapshot: CrisisSnapshot;
  dispatch: CrisisDispatchResult;
  baseline: CrisisDispatchResult | null;
  comparison: CounterfactualComparison | null;
}> = [];

const crisisView = new CrisisView(canvas, selectedUnitCount(), handleWorldMetrics);
crisisView.setSpeed(Number(speedSelect.value));
renderEmptyCallMetrics();
setModeNote();

modeSelect.addEventListener("change", setModeNote);
unitCountSelect.addEventListener("change", resetWorld);
speedSelect.addEventListener("change", () => {
  crisisView.setSpeed(Number(speedSelect.value));
});
dispatchButton.addEventListener("click", () => {
  void dispatchWave(false);
});
pauseButton.addEventListener("click", () => {
  paused = crisisView.togglePause();
  pauseButton.textContent = paused ? "Start simulation" : "Pause simulation";
});
resetButton.addEventListener("click", resetWorld);
downloadButton.addEventListener("click", downloadSession);

void initialise();

function applyQueryDefaults(): void {
  const parameters = new URLSearchParams(window.location.search);
  const teams = parameters.get("teams");
  if (teams && ["8", "16", "32", "48"].includes(teams)) {
    unitCountSelect.value = teams;
    dispatchButton.textContent = `Dispatch ${teams} teams`;
  }

  const speed = parameters.get("speed");
  if (speed && ["1", "2", "4", "8"].includes(speed)) {
    speedSelect.value = speed;
  }

  if (parameters.get("auto") === "0") {
    autoDispatchInput.checked = false;
  }
}

async function initialise(): Promise<void> {
  try {
    serverStatus = await getServerStatus();
    renderStatus(serverStatus);
    try {
      renderBenchmark(await getFanoutEvidence());
    } catch (error) {
      benchmarkMeta.textContent = "Evidence unavailable";
      benchmarkRows.innerHTML = `<tr><td colspan="9">${normalizeError(error)}</td></tr>`;
    }
  } catch (error) {
    statusPill.textContent = "Server unavailable";
    statusPill.className = "status-pill status-error";
    modeSelect.value = "local";
    modeSelect.disabled = true;
    dispatchButton.disabled = true;
    setOperationMessage(normalizeError(error), true);
  }
}

function renderBenchmark(evidence: FanoutBenchmarkEvidence): void {
  benchmarkMeta.textContent =
    `${evidence.model} | ${evidence.repetitions} calls per scale | ` +
    new Date(evidence.generatedAt).toLocaleString();
  benchmarkRows.replaceChildren(
    ...evidence.summary.map((entry) => {
      const row = document.createElement("tr");
      const values = [
        String(entry.units),
        String(entry.questions),
        `${entry.medianLatencyMs.toFixed(1)} ms`,
        entry.medianDecisionsPerSecond.toFixed(1),
        entry.medianInputTokens.toLocaleString(),
        `$${entry.totalEstimatedCostUsd.toFixed(6)}`,
        String(entry.totalCapacityViolations),
        `${entry.jevPreferredBranches} / ${entry.localPreferredBranches} / ${entry.tiedBranches}`,
        signed(entry.medianSeverityExposureDelta),
      ];
      for (const value of values) {
        const cell = document.createElement("td");
        cell.textContent = value;
        row.append(cell);
      }
      return row;
    }),
  );
}

async function dispatchWave(automatic: boolean): Promise<void> {
  if (dispatchInFlight || !currentSnapshot || currentSnapshot.finished) {
    return;
  }
  if (currentSnapshot.incidents.length === 0) {
    setOperationMessage(
      automatic
        ? "No active incidents. Autonomous dispatch is waiting for the next event."
        : "There are no active incidents to dispatch.",
    );
    return;
  }

  const doctrine = doctrineInput.value.trim();
  if (doctrine.length < 3) {
    setOperationMessage("Enter a command doctrine.", true);
    return;
  }

  const mode = modeSelect.value as DecisionMode;
  if (mode === "jev" && !serverStatus?.jevAvailable) {
    setOperationMessage("Jev mode requires TYPESAFE_API_KEY on the server.", true);
    return;
  }

  dispatchInFlight = true;
  setBusy(
    dispatchButton,
    true,
    mode === "jev"
      ? `Evaluating ${currentSnapshot.units.length} teams...`
      : "Computing baseline...",
  );
  setOperationMessage(
    `${automatic ? "Automatic" : "Manual"} ${mode} dispatch started from a frozen world snapshot.`,
  );
  const snapshot = currentSnapshot;
  const dispatchRevision = worldRevision;

  try {
    const dispatch = await dispatchCrisis({
      snapshot,
      doctrine,
      mode,
    });
    const baseline =
      mode === "jev"
        ? await dispatchCrisis({
            snapshot,
            doctrine,
            mode: "local",
          })
        : null;
    if (dispatchRevision !== worldRevision) {
      setOperationMessage("Discarded a dispatch response from the previous world state.");
      return;
    }
    const comparison = baseline
      ? compareDispatchPolicies(
          snapshot,
          dispatch.decisions.map((decision) => ({
            unitId: decision.unitId,
            taskId: decision.assignedTaskId,
          })),
          baseline.decisions.map((decision) => ({
            unitId: decision.unitId,
            taskId: decision.assignedTaskId,
          })),
          20,
        )
      : null;

    lastDispatch = dispatch;
    lastDispatchSnapshot = snapshot;
    sessionTrace.push({
      snapshot,
      dispatch,
      baseline,
      comparison,
    });
    crisisView.applyDispatch(dispatch);
    crisisView.setPaused(false);
    paused = false;
    pauseButton.textContent = "Pause simulation";
    lastDispatchSimulationSecond = snapshot.elapsedSeconds;
    if (automatic) {
      automaticCalls += 1;
    }

    renderDispatch(dispatch, snapshot, baseline, comparison);
    setOperationMessage(
      `${dispatch.unitQuestionCount} team decisions returned in ${dispatch.latencyMs.toFixed(1)} ms and composed into one valid plan.`,
    );
  } catch (error) {
    setOperationMessage(normalizeError(error), true);
    autoDispatchInput.checked = false;
  } finally {
    dispatchInFlight = false;
    setBusy(dispatchButton, false, `Dispatch ${selectedUnitCount()} teams`);
  }
}

function handleWorldMetrics(metricsValue: CrisisFrameMetrics, snapshot: CrisisSnapshot): void {
  currentMetrics = metricsValue;
  currentSnapshot = snapshot;
  renderWorldMetrics(metricsValue);

  if (
    autoDispatchInput.checked &&
    serverStatus !== null &&
    !dispatchInFlight &&
    !metricsValue.finished &&
    snapshot.incidents.length > 0 &&
    (lastDispatch === null || metricsValue.elapsedSeconds - lastDispatchSimulationSecond >= 10)
  ) {
    if (automaticCalls >= 8) {
      autoDispatchInput.checked = false;
      setOperationMessage(
        "Automatic dispatch stopped after the configured eight-call safety limit.",
      );
    } else {
      void dispatchWave(true);
    }
  }
}

function renderStatus(status: ServerStatus): void {
  if (status.jevAvailable) {
    statusPill.textContent = "Jev ready";
    statusPill.className = "status-pill status-ready";
    modelStatus.textContent = status.jevModel;
    modeSelect.value = "jev";
  } else {
    statusPill.textContent = "Local mode";
    statusPill.className = "status-pill status-local";
    modelStatus.textContent = "Set TYPESAFE_API_KEY to enable Jev";
    const jevOption = modeSelect.querySelector<HTMLOptionElement>('option[value="jev"]');
    if (jevOption) {
      jevOption.disabled = true;
    }
    modeSelect.value = "local";
  }
  setModeNote();
}

function setModeNote(): void {
  modeNote.textContent =
    modeSelect.value === "jev"
      ? "One paid request evaluates every visible team plus three global judgements. Auto-dispatch is on by default and capped at eight calls."
      : "The local baseline uses the same state, capacities, optimiser, and simulation without a model call.";
}

function resetWorld(): void {
  worldRevision += 1;
  crisisView.reset(selectedUnitCount());
  crisisView.setSpeed(Number(speedSelect.value));
  paused = true;
  pauseButton.textContent = "Start simulation";
  lastDispatch = null;
  lastDispatchSnapshot = null;
  sessionTrace.length = 0;
  automaticCalls = 0;
  lastDispatchSimulationSecond = 0;
  autoDispatchInput.checked = true;
  assignmentSummary.innerHTML = '<p class="muted-copy">No assignments yet.</p>';
  decisionRows.innerHTML = '<tr><td colspan="5">Dispatch teams to populate the matrix.</td></tr>';
  waveSummary.textContent = "No dispatch wave yet";
  baselineComparison.textContent =
    "A matching local baseline will be evaluated automatically after each Jev wave.";
  counterfactualSummary.textContent = "Dispatch with Jev to compare outcomes";
  counterfactualGrid.innerHTML = `
    <p class="muted-copy">
      The Jev and local assignments will be applied to cloned worlds with identical future
      incident arrivals.
    </p>
  `;
  renderEmptyCallMetrics();
  setOperationMessage("World reset. Automatic dispatch will restart.");
}

function renderWorldMetrics(metricsValue: CrisisFrameMetrics): void {
  const cards: Array<[string, string, string]> = [
    [
      "Time remaining",
      formatTime(metricsValue.timeRemaining),
      `${Number(speedSelect.value)}x simulation`,
    ],
    [
      "Active incidents",
      String(metricsValue.activeIncidents),
      `${metricsValue.assignedUnits} teams deployed`,
    ],
    ["Average severity", metricsValue.averageSeverity.toFixed(1), "Failure occurs at 200"],
    [
      "Average stamina",
      `${metricsValue.averageStamina.toFixed(1)}%`,
      "Recovery restores effectiveness",
    ],
    ["Resolved", String(metricsValue.resolvedIncidents), "Contained incidents"],
    ["Failed", String(metricsValue.failedIncidents), "Uncontained incidents"],
    ["Civilian losses", String(metricsValue.civilianLosses), "Failure consequence"],
    ["Score", String(metricsValue.score), "Resolution minus failure cost"],
  ];
  renderMetricCards(worldMetrics, cards);
}

function renderDispatch(
  dispatch: CrisisDispatchResult,
  snapshot: CrisisSnapshot,
  baseline: CrisisDispatchResult | null,
  comparison: CounterfactualComparison | null,
): void {
  const cards: Array<[string, string, string]> = [
    ["Questions", String(dispatch.questionCount), `${dispatch.unitQuestionCount} team assignments`],
    ["Latency", `${dispatch.latencyMs.toFixed(1)} ms`, dispatch.model],
    ["Throughput", dispatch.decisionsPerSecond.toFixed(1), "Team decisions per second"],
    [
      "Input tokens",
      dispatch.usage.inputTokens.toLocaleString(),
      `$${dispatch.usage.estimatedInputCostUsd.toFixed(6)}`,
    ],
    ["Risk", `${dispatch.global.riskScore.toFixed(2)} / 4`, "Jev global score"],
    [
      "Coordination",
      `${dispatch.global.coordinationScore.toFixed(2)} / 3`,
      "Expected allocation pressure",
    ],
    ["Reassess soon", percentage(dispatch.global.redispatchProbability), "Jev Noul probability"],
    [
      "Capacity overrides",
      String(
        dispatch.decisions.filter((decision) => decision.modelChoice !== decision.assignedTaskId)
          .length,
      ),
      "Top choice changed by optimiser",
    ],
  ];
  renderMetricCards(callMetrics, cards);
  waveSummary.textContent =
    `${dispatch.mode.toUpperCase()} | ${dispatch.unitQuestionCount} teams | ` +
    `${dispatch.latencyMs.toFixed(0)} ms`;

  const counts = assignmentCounts(dispatch);
  assignmentSummary.replaceChildren(
    ...counts.map(({ taskId, count }) => {
      const row = document.createElement("div");
      row.className = "assignment-row";
      const label = document.createElement("span");
      label.textContent = incidentName(snapshot, taskId);
      const value = document.createElement("strong");
      value.textContent = String(count);
      row.append(label, value);
      return row;
    }),
  );

  decisionRows.replaceChildren(
    ...dispatch.decisions.map((decision) => {
      const row = document.createElement("tr");
      if (decision.modelChoice !== decision.assignedTaskId) {
        row.className = "assignment-overridden";
      }

      for (const value of [
        decision.unitId,
        humanize(decision.role),
        incidentName(snapshot, decision.modelChoice),
        incidentName(snapshot, decision.assignedTaskId),
      ]) {
        const cell = document.createElement("td");
        cell.textContent = value;
        row.append(cell);
      }

      const confidenceCell = document.createElement("td");
      const confidence = document.createElement("div");
      confidence.className = "confidence-meter";
      const fill = document.createElement("i");
      fill.style.width = `${decision.confidence * 100}%`;
      const label = document.createElement("span");
      label.textContent = percentage(decision.confidence);
      confidence.append(fill, label);
      confidenceCell.append(confidence);
      row.append(confidenceCell);
      return row;
    }),
  );

  baselineComparison.textContent = baseline
    ? compareWithBaseline(dispatch, baseline, snapshot)
    : "This wave is the local deterministic baseline.";
  renderCounterfactual(comparison);
}

function renderCounterfactual(comparison: CounterfactualComparison | null): void {
  if (!comparison) {
    counterfactualSummary.textContent = "Available after a Jev dispatch";
    counterfactualGrid.innerHTML = `
      <p class="muted-copy">Local-only waves do not create a policy comparison.</p>
    `;
    return;
  }

  counterfactualSummary.textContent =
    comparison.preferredPolicy === "tie"
      ? `${comparison.horizonSeconds}s branch: tie`
      : `${comparison.horizonSeconds}s branch favours ${comparison.preferredPolicy.toUpperCase()} on ${humanize(comparison.decidingMetric)}`;
  const rows: Array<[string, string, string]> = [
    [
      "Civilian losses",
      String(comparison.jev.civilianLossesDelta),
      String(comparison.local.civilianLossesDelta),
    ],
    ["Failed incidents", String(comparison.jev.failedDelta), String(comparison.local.failedDelta)],
    [
      "Resolved incidents",
      String(comparison.jev.resolvedDelta),
      String(comparison.local.resolvedDelta),
    ],
    ["Score delta", signed(comparison.jev.scoreDelta), signed(comparison.local.scoreDelta)],
    [
      "Severity exposure",
      comparison.jev.severityExposure.toFixed(1),
      comparison.local.severityExposure.toFixed(1),
    ],
    [
      "Ending stamina",
      comparison.jev.averageStaminaEnd.toFixed(1),
      comparison.local.averageStaminaEnd.toFixed(1),
    ],
  ];
  const table = document.createElement("table");
  table.className = "decision-table counterfactual-table";
  const head = document.createElement("thead");
  head.innerHTML = "<tr><th>Outcome</th><th>Jev plan</th><th>Local plan</th></tr>";
  const body = document.createElement("tbody");

  for (const [label, jevValue, localValue] of rows) {
    const row = document.createElement("tr");
    for (const value of [label, jevValue, localValue]) {
      const cell = document.createElement("td");
      cell.textContent = value;
      row.append(cell);
    }
    body.append(row);
  }

  table.append(head, body);
  counterfactualGrid.replaceChildren(table);
}

function renderEmptyCallMetrics(): void {
  renderMetricCards(callMetrics, [
    ["Questions", "-", "No dispatch wave"],
    ["Latency", "-", "No model call"],
    ["Throughput", "-", "Team decisions per second"],
    ["Input tokens", "-", "No cost"],
    ["Risk", "-", "Awaiting dispatch"],
    ["Coordination", "-", "Awaiting dispatch"],
    ["Reassess soon", "-", "Awaiting dispatch"],
    ["Capacity overrides", "-", "Awaiting dispatch"],
  ]);
}

function renderMetricCards(container: HTMLElement, cards: Array<[string, string, string]>): void {
  container.replaceChildren(
    ...cards.map(([label, value, detail]) => {
      const card = document.createElement("div");
      card.className = "metric-card";
      const labelElement = document.createElement("span");
      labelElement.textContent = label;
      const valueElement = document.createElement("strong");
      valueElement.textContent = value;
      const detailElement = document.createElement("small");
      detailElement.textContent = detail;
      card.append(labelElement, valueElement, detailElement);
      return card;
    }),
  );
}

function compareWithBaseline(
  jev: CrisisDispatchResult,
  baseline: CrisisDispatchResult,
  snapshot: CrisisSnapshot,
): string {
  const baselineByUnit = new Map(
    baseline.decisions.map((decision) => [decision.unitId, decision.assignedTaskId]),
  );
  const agreement = jev.decisions.filter(
    (decision) => baselineByUnit.get(decision.unitId) === decision.assignedTaskId,
  ).length;
  const jevFit = averageRoleFit(jev, snapshot);
  const baselineFit = averageRoleFit(baseline, snapshot);

  return (
    `Jev and the local optimiser agree on ${agreement}/${jev.decisions.length} assignments. ` +
    `Average specialist fit is ${jevFit.toFixed(3)} for Jev and ${baselineFit.toFixed(3)} for the baseline. ` +
    "Agreement is descriptive, not a claim that either policy is superior."
  );
}

function averageRoleFit(dispatch: CrisisDispatchResult, snapshot: CrisisSnapshot): number {
  const values = dispatch.decisions.flatMap((decision) => {
    const incident = snapshot.incidents.find(
      (candidate) => candidate.id === decision.assignedTaskId,
    );
    return incident ? [roleFit(decision.role, incident.kind)] : [];
  });

  return values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length;
}

function downloadSession(): void {
  const payload = {
    generatedAt: new Date().toISOString(),
    latestWorld: currentSnapshot,
    latestMetrics: currentMetrics,
    latestDispatch: lastDispatch,
    latestDispatchSnapshot: lastDispatchSnapshot,
    waves: sessionTrace,
  };
  const blob = new Blob([`${JSON.stringify(payload, null, 2)}\n`], {
    type: "application/json",
  });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `jev-command-trace-${new Date().toISOString().replaceAll(/[:.]/g, "-")}.json`;
  anchor.click();
  URL.revokeObjectURL(url);
}

function selectedUnitCount(): number {
  return Number(unitCountSelect.value);
}

function setBusy(button: HTMLButtonElement, busy: boolean, label: string): void {
  button.disabled = busy;
  button.textContent = label;
}

function setOperationMessage(message: string, isError = false): void {
  operationMessage.textContent = message;
  operationMessage.classList.toggle("error", isError);
}

function formatTime(seconds: number): string {
  const whole = Math.ceil(seconds);
  const minutes = Math.floor(whole / 60);
  return `${minutes}:${String(whole % 60).padStart(2, "0")}`;
}

function percentage(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

function signed(value: number): string {
  return value > 0 ? `+${value}` : String(value);
}

function humanize(value: string): string {
  return value.replaceAll("_", " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function normalizeError(error: unknown): string {
  return error instanceof Error ? error.message : "Unexpected application error.";
}

function requireElement<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (!element) {
    throw new Error(`Required element #${id} was not found.`);
  }
  return element as T;
}
