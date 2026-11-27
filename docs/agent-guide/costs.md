# Costs and approval
Estimate each run and get the person's approval before spending.

1. Call `estimate_run` before every `run_workflow`, including partial or forced runs. Keep inputs, mode, targets and force identical between estimate and start. Show paid steps, unknown prices and the proposed maximum to the person; never start paid steps without their yes.
2. Pass the agreed max_usd to `run_workflow` (0 for free work). This ceiling does not override the key's per-run or monthly limit, the person's budget, or the team budget for participants. Monthly checks include booked costs and reservations. A key may have at most two runs in progress.
3. Unknown paid prices and credit-priced steps block agent runs; Higgsfield steps run once the server sets a USD rate per credit, and then count in USD like any other cost. Do not invent a price or bypass the blocker. A changed estimate needs a new decision if it exceeds the approved ceiling.
4. A run with status awaiting_approval is paused because its next paid step needs more than the approved max_usd; `get_run` shows the required amount under approval. Ask the person before `resume_run` (run_id, the agreed higher max_usd). Use `cancel_run` if they decline.
5. Use `get_workflow_costs` with workflow_id for costs already incurred; an estimate is not a bill. `get_run` follows the current run.
