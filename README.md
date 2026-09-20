# Jev Parallel Dispatch

Jev Parallel Dispatch is a browser simulation for testing high-volume typed decisions
against a shared, changing game state.

Jev evaluates 8 to 48 specialist response teams in one request. Each team receives a
`Choice` over the active incidents, recovery, or holding position. The same request
returns global `Score` and `Noul` judgements for operational risk, coordination
pressure, and when to reassess.

The model does not control the simulation directly. A deterministic optimiser consumes
the returned probability matrix, blends uncertain answers with a local policy, and
enforces each incident's capacity before applying assignments.

## How it works

```text
shared world state
  -> one typed Jev question per response team
  -> probability distributions and confidence values
  -> confidence-aware blending with a local policy
  -> maximum-weight capacity-constrained assignment
  -> deterministic simulation
  -> same-snapshot Jev versus local counterfactual
```

The simulation includes:

- Medic, engineer, firefighter, and scout teams.
- Fire, medical, infrastructure, and search incidents.
- Incident growth, failure thresholds, civilian losses, stamina, and recovery.
- Automatic dispatch with an eight-call safety cap.
- A deterministic local baseline after every Jev wave.
- A 20-second counterfactual branch from the same frozen snapshot.
- Live latency, throughput, token, cost, confidence, and assignment reporting.
- Downloadable world snapshots and decision traces.

Movement and incident resolution run locally and make no model calls. Automatic dispatch
waits without spending tokens when no incidents are active.

## Clone and run

Requirements:

- Node.js 22 or newer.
- A TypeSafe API key for live Jev mode.

```bash
git clone https://github.com/Jason-Doyle/jev-parallel-dispatch.git
cd jev-parallel-dispatch
npm ci
```

Create a local environment file:

```bash
cp .env.example .env
```

PowerShell:

```powershell
Copy-Item .env.example .env
```

Set `TYPESAFE_API_KEY` in `.env`, then start the development servers:

```bash
npm run dev
```

Open <http://localhost:5173>.

Without a key, the application uses the deterministic local dispatcher.

## Production build

```bash
npm run build
npm start
```

Open <http://127.0.0.1:8787>.

The API key remains on the server. It is not sent to the browser or written to the
retained evidence.

## Technical details

The browser owns the deterministic world simulation. It sends a serialisable snapshot
and operator doctrine to the server for each dispatch wave.

The server builds one `Choice` question for every team and three global questions. Jev
evaluates all questions against the same state. The dispatcher then:

1. Reads every task probability for every team.
2. Blends each distribution with a deterministic local utility policy according to Jev
   confidence.
3. Expands incidents into capacity-limited assignment slots.
4. Solves a maximum-weight assignment across all teams and slots.
5. Returns both the model's top choice and the applied assignment.

When Jev mode is active, the browser also evaluates the local policy from the same
snapshot. Both plans are simulated for 20 seconds with identical future incident
arrivals. The comparison ranks outcomes in this order:

1. Fewer civilian losses.
2. Fewer failed incidents.
3. More resolved incidents.
4. Higher score.
5. Lower integrated severity exposure.
6. Higher remaining stamina.

## Validation

```bash
npm run validate
```

This runs Biome, TypeScript, Vitest, and production builds.

The test suite covers deterministic replay, role distribution, capacity enforcement
under adversarial model preferences, identical-snapshot counterfactuals, the HTTP API,
and the official TypeSafe SDK transport.

## Retained benchmark evidence

`evidence/fanout-benchmark.json` contains the raw Jev responses, local assignments, and
counterfactual outcomes from three calls at each scale.

| Teams | Questions | Median latency | Decisions/s | Input tokens | Jev/local/tie branches | Median severity delta |
|---:|---:|---:|---:|---:|---:|---:|
| 8 | 11 | 213.760 ms | 37.425 | 6,683 | 0 / 1 / 2 | 0.000 |
| 16 | 19 | 175.222 ms | 91.313 | 12,127 | 2 / 1 / 0 | -13.345 |
| 32 | 35 | 227.969 ms | 140.370 | 23,017 | 2 / 1 / 0 | -2.948 |
| 48 | 51 | 335.955 ms | 142.876 | 33,887 | 3 / 0 / 0 | -9.258 |

All 12 recorded calls had zero capacity violations. Negative severity delta favours
Jev.

Re-run the benchmark with:

```bash
npm run benchmark:fanout -- --units 8,16,32,48 --repetitions 3
```

This command makes paid Jev calls.

## Limits

The simulation is synthetic. Its incident priorities and role-effectiveness table are
implemented assumptions, not emergency-response policy.

Three scenarios per scale are not enough to claim that Jev is better than the local
dispatcher. The retained data supports claims about the recorded latency, throughput,
capacity-safe composition, and counterfactual outcomes only.

## License

MIT
