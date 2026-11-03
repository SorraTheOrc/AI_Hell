# Experience validation — bot:competent

- Targets: v1 (baseline: competent, 100 games, 18000 ticks, campaign=true)
- Measured: 100 run(s), balance schema v1
- Tolerance: tolerance = max(2 x baseline stdDev, 10% of |centre|, 0.5); upgradesSelected uses max(25% of |centre|, 0.5) because the shared schema aggregates it as a per-key map with no single stdDev; bands are recorded to 4 decimal places
- Result: **PASS** (6/6 metrics in band)

| Metric | Measured | Target band | Drift | Verdict |
|---|---|---|---|---|
| survival (s) | 300.00 | 270.00 – 330.00 (±30.00) | 0.00 (0.0 %) | in-band |
| minerals collected | 18.00 | 16.20 – 19.80 (±1.80) | 0.00 (0.0 %) | in-band |
| upgrades selected / run | 2.00 | 1.50 – 2.50 (±0.50) | 0.00 (0.0 %) | in-band |
| wave reached | 5.89 | 1.50 – 11.42 (±4.96) | -0.57 (-8.8 %) | in-band |
| level reached | 1.09 | 0.44 – 1.86 (±0.71) | -0.06 (-5.2 %) | in-band |
| avoidable hits | 0.00 | -0.50 – 0.50 (±0.50) | 0.00 | in-band |
