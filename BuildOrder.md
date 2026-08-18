Suggested build order (matches your pipeline stages, front-loads risk):

1.Rules-based inference — gives you a working, deterministic pipeline before any LLM cost/latency enters
2.LLM inference + schema gate — layer on top of #2, fallback already exists
3.Pattern classification + diagram templates
4.draw.io XML generation + in-browser preview
5.AWS Price List integration + caching
6.Cost slider (client-side math)
7.Auth + history (do this last — it's the most cuttable if time runs short)
