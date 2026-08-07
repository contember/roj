# Startup probes

A Worker gets **400 ms of CPU to evaluate its modules**. `wrangler check startup`
measures that locally, so the number is reachable without deploying.

Each directory here is a minimal Worker over one slice of the dependency graph,
so the cost can be attributed by difference rather than guessed from a
flamegraph over a 7 MB single-file bundle.

```bash
cd startup-probes/sdk && bunx wrangler check startup     # and baseline/, computer/
cd ../.. && bunx wrangler check startup                  # the real DO harness
```

Entry points live in `../src/startup/`, so they resolve the same workspace
dependencies the harness does. Each run drops a `worker-startup.cpuprofile` in
the working directory — load it in Chrome DevTools for a flamegraph, and delete
it afterwards; it is not tracked.
